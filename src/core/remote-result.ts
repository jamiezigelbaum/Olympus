/**
 * What a remote agent receives: the output boundary of the `remote` operation
 * surface (`/mcp` for non-ChatGPT connections, and `POST /api/v1/tools/<name>`),
 * design docs/design/background-agents.md section C.
 *
 * Remote agents (Grok, Muse, any bearer token or non-ChatGPT OAuth
 * connection) keep the secret-scanned Private summary answer (owner decision
 * 2026-10-12), so this output, not the serialized operation result, is the
 * boundary. Every operation has its own discriminated output, built field by
 * field from an allowlist: a field the worker adds later never reaches a
 * remote agent until it is written here. Concretely:
 *
 * - No audit, policy, lane, provider-identifier, URI, span, Secret count or
 *   Secret location field, in any result or error.
 * - Every retained free-text field (answer, reply, sent question, titles,
 *   route, notes, refusal messages) is secret-scanned with the release gate's
 *   own scanner (`secretLabelsInText`); scalars are fixed enums, identifiers
 *   of a fixed shape, numbers or booleans.
 * - Errors carry a fixed sentence per code, never the internal message.
 * - An answer's cited items are rechecked against their current tiers when it
 *   is collected (`CitedItemCheck`): a cited item now Secret withholds the
 *   answer; a cited item gone drops its citation; a check that cannot run
 *   withholds.
 *
 * The local stdio MCP surface, native OpenClaw and the ChatGPT surface do not
 * use this module; their output is unchanged.
 */
import { boundedLogErrorMessage } from './log-redaction.ts';
import { OperationError, type OperationErrorCode } from './operation-error.ts';
import { secretLabelsInText } from './opsec.ts';
import { withoutSecretLocationCoverageNotes } from './secret-location-note.ts';

/** The operations the remote surface serves (core/public-surface.ts V0_4_PUBLIC_REMOTE_MCP_TOOLS). */
export type RemoteOperationName = 'source_answer' | 'source_answer_result' | 'source_index_status' | 'ask_anonymously';

/** One cited item, as a released answer's evidence names it (no account scope). */
export interface CitedItemRef {
  corpusId: string;
  provider: string;
  providerItemId: string;
  providerConversationId?: string;
}

/**
 * An item's tier now: `secret` (now Secret, or moving to Secret), `gone`
 * (no current copy anywhere), `current`, or `unknown` (no per-item tier to
 * recheck: a legacy corpus or an item never placed by the tier router).
 */
export type CitedItemVerdict = 'current' | 'secret' | 'gone' | 'unknown';

/** One verdict per item, in order. Throws when the tiers cannot be read; the answer is then withheld. */
export type CitedItemCheck = (items: readonly CitedItemRef[]) => readonly CitedItemVerdict[];

export interface RemoteOutputOptions {
  /** The worker's current-tier check; without one (no tiered stores) cited items are not rechecked. */
  citedItemCheck?: CitedItemCheck;
}

const MAX_ANSWER = 64 * 1024;
const MAX_SENT = 16 * 1024;
const MAX_TITLE = 400;
const MAX_ROUTE = 300;
const MAX_MESSAGE = 2_000;
const MAX_CITATIONS = 50;
const MAX_CORPORA = 200;
const JOB_ID = /^saj_[A-Za-z0-9_-]{43}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const CORPUS_ID = /^[a-z0-9_]+(\.[a-z0-9_-]+)+$/i;
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
// C0/C1 controls (tab, newline and carriage return kept), zero-width and bidi controls.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

export const REMOTE_PENDING_MESSAGE = 'Olympus is still working on this and it keeps running. '
  + 'Call source_answer_result with this job_id to get the result; repeat while it says working. Do not ask again.';
/** A cited item changed tier since the answer was written; neutral, so it says nothing about which tier. */
export const REMOTE_ANSWER_CHANGED = 'Olympus withheld this answer because an item it drew on has changed privacy level since the answer was written. Ask the question again.';
export const REMOTE_ANSWER_WITHHELD = 'Olympus withheld this answer under the owner\'s privacy rules.';
export const REMOTE_REPLY_WITHHELD = 'Olympus withheld the reply because it looked like it contained a password, key or token.';
const REMOTE_REFUSAL_FALLBACK = 'Olympus could not ask anonymously.';
/** What needs_choice tells the agent (the sentence core/consult-ask.ts CONSULT_ASK_MESSAGES.needsChoice says). */
export const REMOTE_NEEDS_CHOICE_MESSAGE = 'Nothing was sent. Ask the user once: Strict (their model rewrites it into general questions first) or Standard (their words, prepared as they choose: as written, light cleanup, or their own instruction). Then call again with level, and remember=true to keep it.';

/* ------------------------------------------------------------------ */
/* Source labels: a fixed vocabulary, never a provider identifier       */
/* ------------------------------------------------------------------ */

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  gmail: 'Gmail',
  google_drive: 'Google Drive',
  'google-drive': 'Google Drive',
  google_calendar: 'Google Calendar',
  dropbox: 'Dropbox',
  x: 'X bookmarks',
  readwise: 'Readwise',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  whatsapp_personal: 'WhatsApp',
  whatsapp_business: 'WhatsApp',
  apple_messages: 'Apple Messages',
  signal: 'Signal',
  reflect: 'Reflect',
  roam: 'Roam',
};

const FAMILY_LABELS: Readonly<Record<string, string>> = {
  email: 'Mail',
  file: 'Files',
  chat: 'Messages',
  note: 'Notes',
  x: 'X bookmarks',
  readwise: 'Readwise',
};

const OTHER_SOURCE_LABEL = 'Other source';

export const REMOTE_SOURCE_LABELS: readonly string[] = Object.freeze([...new Set([
  ...Object.values(PROVIDER_LABELS),
  ...Object.values(FAMILY_LABELS),
  OTHER_SOURCE_LABEL,
])].sort());

function sourceLabel(provider: unknown, family: unknown): string {
  if (typeof provider === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, provider)) return PROVIDER_LABELS[provider]!;
  if (typeof family === 'string' && Object.prototype.hasOwnProperty.call(FAMILY_LABELS, family)) return FAMILY_LABELS[family]!;
  return OTHER_SOURCE_LABEL;
}

/* ------------------------------------------------------------------ */
/* Per-operation output                                                */
/* ------------------------------------------------------------------ */

/**
 * The remote output for one operation's raw result. Throws an
 * OperationError when the raw result is not a shape this boundary knows; the
 * caller turns it into a fixed error like any other.
 */
export function remoteOperationOutput(
  operation: string,
  raw: unknown,
  options: RemoteOutputOptions = {},
): Record<string, unknown> {
  const pending = pendingOutput(raw);
  switch (operation) {
    case 'source_answer':
      return pending ?? sourceAnswerOutput(raw, options);
    case 'ask_anonymously':
      return pending ?? anonymousAnswerOutput(raw);
    case 'source_answer_result':
      // Two families: a handed-off source_answer or a handed-off ask_anonymously.
      return pending ?? (isAnonymousAnswerResult(raw) ? anonymousAnswerOutput(raw) : sourceAnswerOutput(raw, options));
    case 'source_index_status':
      return sourceIndexStatusOutput(raw);
    default:
      throw new OperationError('invalid_request', `No remote output for operation ${operation}.`);
  }
}

/** An ask_anonymously outcome (core/consult-ask.ts ConsultAskResult). */
export function isAnonymousAnswerResult(raw: unknown): boolean {
  const record = asRecord(raw);
  return record !== undefined && typeof record.ok === 'boolean' && typeof record.answer !== 'string';
}

function pendingOutput(raw: unknown): Record<string, unknown> | undefined {
  const record = asRecord(raw);
  if (record?.status !== 'working') return undefined;
  if (typeof record.job_id !== 'string' || !JOB_ID.test(record.job_id)) {
    throw new OperationError('source_index_error', 'unexpected pending shape');
  }
  return {
    status: 'working',
    job_id: record.job_id,
    elapsed_ms: wholeNumber(record.elapsed_ms),
    next_tool: 'source_answer_result',
    message: REMOTE_PENDING_MESSAGE,
  };
}

function sourceAnswerOutput(raw: unknown, options: RemoteOutputOptions): Record<string, unknown> {
  const record = asRecord(raw);
  if (!record || typeof record.answer !== 'string' || !Array.isArray(record.evidence)) {
    throw new OperationError('source_index_error', 'unexpected answer shape');
  }
  const evidence = record.evidence.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const verdicts = recheckCitedItems(evidence, options.citedItemCheck);
  if (verdicts === 'withhold') return withheldAnswer(REMOTE_ANSWER_CHANGED);
  const answer = cleanMultiline(withoutSecretLocationCoverageNotes(record.answer), MAX_ANSWER);
  if (isSecretLike(answer)) return withheldAnswer(REMOTE_ANSWER_WITHHELD);
  const citations: Array<Record<string, unknown>> = [];
  evidence.forEach((entry, index) => {
    if (verdicts?.[index] === 'gone' || citations.length >= MAX_CITATIONS) return;
    citations.push(citationOutput(entry));
  });
  return { kind: 'source_answer', status: 'answered', answer, citations };
}

function withheldAnswer(message: string): Record<string, unknown> {
  return { kind: 'source_answer', status: 'withheld', answer: message, citations: [] };
}

/**
 * Per-entry verdicts, or 'withhold' when a cited item is now Secret or the
 * check cannot run. Undefined when there is nothing to recheck.
 */
function recheckCitedItems(
  evidence: readonly Record<string, unknown>[],
  check: CitedItemCheck | undefined,
): Array<CitedItemVerdict | undefined> | 'withhold' | undefined {
  if (!check || evidence.length === 0) return undefined;
  const refs = evidence.map(citedItemRef);
  const checkable = refs.flatMap((ref, index) => (ref ? [{ ref, index }] : []));
  if (checkable.length === 0) return undefined;
  let verdicts: readonly CitedItemVerdict[];
  try {
    verdicts = check(checkable.map(({ ref }) => ref));
    if (verdicts.length !== checkable.length) throw new Error('cited item check returned the wrong number of verdicts');
  } catch (error) {
    console.error(`[olympus:remote] cited_item_check_failed error_message=${boundedLogErrorMessage(error)}`);
    return 'withhold';
  }
  if (verdicts.some((verdict) => verdict === 'secret')) return 'withhold';
  const byIndex: Array<CitedItemVerdict | undefined> = evidence.map(() => undefined);
  checkable.forEach(({ index }, position) => { byIndex[index] = verdicts[position]; });
  return byIndex;
}

function citedItemRef(entry: Record<string, unknown>): CitedItemRef | undefined {
  const { corpus_id: corpusId, provider, provider_item_id: providerItemId, provider_conversation_id: conversation } = entry;
  if (typeof corpusId !== 'string' || typeof provider !== 'string' || typeof providerItemId !== 'string') return undefined;
  if (!corpusId || !provider || !providerItemId) return undefined;
  return {
    corpusId,
    provider,
    providerItemId,
    ...(typeof conversation === 'string' && conversation ? { providerConversationId: conversation } : {}),
  };
}

/** Label, title and date only: no provider identifiers, URIs, spans or trust fields. */
function citationOutput(entry: Record<string, unknown>): Record<string, unknown> {
  const title = cleanLine(entry.title, MAX_TITLE);
  const date = dateOnly(entry.authored_at) ?? dateOnly(entry.updated_at);
  return {
    label: sourceLabel(entry.provider, entry.family),
    ...(title && !isSecretLike(title) ? { title } : {}),
    ...(date ? { date } : {}),
  };
}

function anonymousAnswerOutput(raw: unknown): Record<string, unknown> {
  const record = asRecord(raw);
  if (!record || typeof record.ok !== 'boolean') {
    throw new OperationError('email_error', 'unexpected anonymous answer shape');
  }
  if (record.ok) {
    if (typeof record.reply !== 'string') throw new OperationError('email_error', 'unexpected anonymous answer shape');
    const reply = cleanMultiline(record.reply, MAX_ANSWER);
    const sent = scannedMultiline(record.sent, MAX_SENT);
    const route = scannedLine(record.route, MAX_ROUTE);
    const note = scannedLine(record.note, MAX_MESSAGE);
    const model = typeof record.model === 'string' && MODEL_ID.test(record.model) ? record.model : undefined;
    return {
      kind: 'anonymous_answer',
      status: 'answered',
      reply: isSecretLike(reply) ? REMOTE_REPLY_WITHHELD : reply,
      level: record.level === 'strict' ? 'strict' : 'standard',
      rewritten: record.rewritten === true,
      remembered: record.remembered === true,
      // Anonymous only when the network address was hidden (Tor, verified).
      network_identity: record.networkIdentity === 'hidden' || record.networkIdentity === 'visible' ? record.networkIdentity : 'not_verified',
      ...(record.cleanup === 'as_written' || record.cleanup === 'light_cleanup' || record.cleanup === 'custom' ? { cleanup: record.cleanup } : {}),
      ...(model ? { model } : {}),
      ...(route ? { route } : {}),
      ...(sent ? { sent } : {}),
      ...(note ? { note } : {}),
    };
  }
  if (record.code === 'needs_choice') {
    // Nothing was sent: the user is asked once, Strict or Standard.
    const options = asRecord(record.options);
    return {
      kind: 'anonymous_answer',
      status: 'needs_choice',
      message: REMOTE_NEEDS_CHOICE_MESSAGE,
      options: {
        suggested_level: options?.suggestedLevel === 'strict' ? 'strict' : 'standard',
        suggested_cleanup: options?.suggestedCleanup === 'light_cleanup' || options?.suggestedCleanup === 'custom'
          ? options.suggestedCleanup
          : 'as_written',
        custom_instruction: options?.customInstruction === true,
      },
    };
  }
  const sent = scannedMultiline(record.sent, MAX_SENT);
  return {
    kind: 'anonymous_answer',
    status: 'refused',
    code: typeof record.code === 'string' && CODE.test(record.code) ? record.code : 'refused',
    message: scannedLine(record.message, MAX_MESSAGE) ?? REMOTE_REFUSAL_FALLBACK,
    // Whether the question left: absent means it was never handed to the
    // transport; `not_sent` refused before it left; `sent_failed` or
    // `unknown` may have spent from the user's zkAPI balance.
    ...(record.outcome === 'not_sent' || record.outcome === 'sent_failed' || record.outcome === 'unknown' ? { outcome: record.outcome } : {}),
    ...(typeof record.daemonCode === 'string' && CODE.test(record.daemonCode) ? { daemon_code: record.daemonCode } : {}),
    ...(sent ? { sent } : {}),
  };
}

const TRUST_DOMAINS = new Set(['public_safe', 'internal', 'secure_local']);

/** Per-corpus status and counts; every other status field stays on the computer. */
function sourceIndexStatusOutput(raw: unknown): Record<string, unknown> {
  const record = asRecord(raw);
  if (!record || record.kind !== 'source_index_status' || !Array.isArray(record.corpora)) {
    throw new OperationError('source_index_error', 'unexpected status shape');
  }
  const generatedAt = iso(record.generated_at);
  const corpora: Array<Record<string, unknown>> = [];
  for (const value of record.corpora) {
    if (corpora.length >= MAX_CORPORA) break;
    const corpus = asRecord(value);
    if (!corpus || typeof corpus.corpus_id !== 'string' || !CORPUS_ID.test(corpus.corpus_id) || corpus.corpus_id.length > 128) continue;
    const retrieval = asRecord(corpus.retrieval);
    const mode = retrieval?.servable_mode === 'keyword' || retrieval?.servable_mode === 'hybrid' ? retrieval.servable_mode : undefined;
    const state = retrieval?.state === 'ready' || retrieval?.state === 'degraded' ? retrieval.state : undefined;
    const refresh = asRecord(corpus.last_refresh);
    const refreshStatus = typeof refresh?.status === 'string' && CODE.test(refresh.status) ? refresh.status : undefined;
    const completedAt = iso(refresh?.completed_at);
    const counts = asRecord(corpus.counts);
    corpora.push({
      corpus_id: corpus.corpus_id,
      label: sourceLabel(corpus.provider, corpus.family),
      ...(typeof corpus.trust_domain === 'string' && TRUST_DOMAINS.has(corpus.trust_domain) ? { trust_domain: corpus.trust_domain } : {}),
      configured: corpus.configured === true,
      ...(mode && state ? { retrieval: { mode, state } } : {}),
      ...(refreshStatus ? { last_refresh: { status: refreshStatus, ...(completedAt ? { completed_at: completedAt } : {}) } } : {}),
      ...(counts
        ? {
            counts: {
              indexed_items: wholeNumber(counts.indexed_items),
              chunks: wholeNumber(counts.chunks),
              embedded_chunks: wholeNumber(counts.embedded_chunks),
            },
          }
        : {}),
    });
  }
  return { kind: 'source_index_status', ...(generatedAt ? { generated_at: generatedAt } : {}), corpora };
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type RemoteErrorCode = OperationErrorCode | 'internal_error' | 'unknown_operation' | 'operation_unavailable';

const REMOTE_ERROR_TEXT: Readonly<Record<RemoteErrorCode, string>> = {
  invalid_params: 'The request was not valid. Check the arguments against the tool\'s schema and try again.',
  invalid_request: 'The request was not valid. Check the arguments against the tool\'s schema and try again.',
  unsupported_filter: 'That filter is not supported here.',
  config_error: 'Olympus on the computer needs setup before it can answer.',
  argus_unreachable: 'Olympus could not reach its private analyst. Try again later.',
  argus_error: 'Olympus\'s private analyst could not answer. Try again later.',
  email_not_configured: 'Olympus on the computer needs setup before it can answer.',
  email_unreachable: 'Olympus could not reach its source worker in time. Try again later.',
  email_error: 'Olympus could not complete this request.',
  email_policy_violation: 'Olympus withheld this result under the owner\'s privacy rules.',
  source_index_not_enabled: 'Searching sources is not turned on in Olympus on the computer.',
  source_index_policy_violation: 'Olympus withheld this result under the owner\'s privacy rules.',
  source_index_error: 'Olympus could not complete this request.',
  source_answer_busy: 'Olympus is already answering as many questions as it can at once. Wait for the answers in progress (call source_answer_result with their job ids), then ask again.',
  source_answer_job_not_found: 'No Olympus answer with that job_id is available to this connection. It may have expired or Olympus may have restarted. Ask the question again with source_answer.',
  source_answer_deadline: 'The answer did not finish within Olympus\'s time limit and was stopped. Ask a narrower question, or try again later.',
  source_answer_too_large: 'The finished answer was too large for Olympus to return. Ask a narrower question.',
  internal_error: 'Olympus could not complete this request.',
  unknown_operation: 'Olympus has no operation with that name here.',
  operation_unavailable: 'That operation is not enabled on this Olympus install.',
};

export const REMOTE_ERROR_CODES: readonly RemoteErrorCode[] = Object.freeze(Object.keys(REMOTE_ERROR_TEXT) as RemoteErrorCode[]);

/**
 * Codes whose fixed sentence cannot say what went wrong: each carries a
 * reference, logged on the computer beside the error's own bounded message
 * (owner rule 2026-10-10: every problem findable).
 */
const REFERENCED_ERROR_CODES: ReadonlySet<RemoteErrorCode> = new Set<RemoteErrorCode>([
  'internal_error',
  'email_error',
  'source_index_error',
  'argus_error',
  'config_error',
]);

export function remoteErrorCode(error: unknown): RemoteErrorCode {
  if (error instanceof OperationError && Object.prototype.hasOwnProperty.call(REMOTE_ERROR_TEXT, error.code)) return error.code;
  return 'internal_error';
}

/** `{ error, message, ref? }`: a fixed sentence per code; the internal message never leaves. */
export function remoteErrorOutput(error: unknown): { error: RemoteErrorCode; message: string; ref?: string } {
  const code = remoteErrorCode(error);
  if (!REFERENCED_ERROR_CODES.has(code)) return { error: code, message: REMOTE_ERROR_TEXT[code] };
  const ref = mintErrorRef();
  const errorClass = error instanceof Error ? error.name : typeof error;
  console.error(`[olympus:remote] tool_error code=${code} ref=${ref} class=${JSON.stringify(errorClass)} error_message=${boundedLogErrorMessage(error)}`);
  return { error: code, message: REMOTE_ERROR_TEXT[code], ref };
}

/** A surface-level refusal (no such operation, or switched off here). */
export function remoteSurfaceErrorOutput(code: 'unknown_operation' | 'operation_unavailable'): { error: RemoteErrorCode; message: string } {
  return { error: code, message: REMOTE_ERROR_TEXT[code] };
}

function mintErrorRef(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* Output schemas (OpenAPI 3.1 / JSON Schema 2020-12)                  */
/* ------------------------------------------------------------------ */

const PENDING_SCHEMA = {
  type: 'object',
  description: 'Still working: call source_answer_result with job_id, again while it says working.',
  additionalProperties: false,
  required: ['status', 'job_id', 'elapsed_ms', 'next_tool', 'message'],
  properties: {
    status: { const: 'working' },
    job_id: { type: 'string', pattern: JOB_ID.source },
    elapsed_ms: { type: 'integer', minimum: 0 },
    next_tool: { const: 'source_answer_result' },
    message: { type: 'string' },
  },
} as const;

const CITATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label'],
  properties: {
    label: { type: 'string', enum: [...REMOTE_SOURCE_LABELS] },
    title: { type: 'string', maxLength: MAX_TITLE },
    date: { type: 'string', format: 'date' },
  },
} as const;

const SOURCE_ANSWER_SCHEMA = {
  type: 'object',
  description: 'A source answer: give the answer with its citations. "withheld" carries a fixed sentence to pass on instead.',
  additionalProperties: false,
  required: ['kind', 'status', 'answer', 'citations'],
  properties: {
    kind: { const: 'source_answer' },
    status: { enum: ['answered', 'withheld'] },
    answer: { type: 'string' },
    citations: { type: 'array', maxItems: MAX_CITATIONS, items: CITATION_SCHEMA },
  },
} as const;

const ANONYMOUS_ANSWERED_SCHEMA = {
  type: 'object',
  description: 'The anonymous reply. When rewritten is true, say the question was rewritten first and offer to show "sent".',
  additionalProperties: false,
  required: ['kind', 'status', 'reply', 'level', 'rewritten', 'remembered', 'network_identity'],
  properties: {
    kind: { const: 'anonymous_answer' },
    status: { const: 'answered' },
    reply: { type: 'string' },
    level: { enum: ['strict', 'standard'] },
    rewritten: { type: 'boolean' },
    remembered: { type: 'boolean' },
    network_identity: { enum: ['hidden', 'visible', 'not_verified'] },
    cleanup: { enum: ['as_written', 'light_cleanup', 'custom'] },
    model: { type: 'string', pattern: MODEL_ID.source },
    route: { type: 'string', maxLength: MAX_ROUTE },
    sent: { type: 'string', maxLength: MAX_SENT },
    note: { type: 'string', maxLength: MAX_MESSAGE },
  },
} as const;

const ANONYMOUS_NEEDS_CHOICE_SCHEMA = {
  type: 'object',
  description: 'Nothing was sent: ask the user once, Strict or Standard, then call again with level (and remember=true to keep it).',
  additionalProperties: false,
  required: ['kind', 'status', 'message', 'options'],
  properties: {
    kind: { const: 'anonymous_answer' },
    status: { const: 'needs_choice' },
    message: { type: 'string' },
    options: {
      type: 'object',
      additionalProperties: false,
      required: ['suggested_level', 'suggested_cleanup', 'custom_instruction'],
      properties: {
        suggested_level: { enum: ['strict', 'standard'] },
        suggested_cleanup: { enum: ['as_written', 'light_cleanup', 'custom'] },
        custom_instruction: { type: 'boolean' },
      },
    },
  },
} as const;

const ANONYMOUS_REFUSED_SCHEMA = {
  type: 'object',
  description: 'Not answered: tell the user the message in those words. outcome says whether the question left (absent: never handed to the transport).',
  additionalProperties: false,
  required: ['kind', 'status', 'code', 'message'],
  properties: {
    kind: { const: 'anonymous_answer' },
    status: { const: 'refused' },
    code: { type: 'string', pattern: CODE.source },
    message: { type: 'string', maxLength: MAX_MESSAGE },
    outcome: { enum: ['not_sent', 'sent_failed', 'unknown'] },
    daemon_code: { type: 'string', pattern: CODE.source },
    sent: { type: 'string', maxLength: MAX_SENT },
  },
} as const;

const SOURCE_INDEX_STATUS_SCHEMA = {
  type: 'object',
  description: 'Per-corpus status and counts.',
  additionalProperties: false,
  required: ['kind', 'corpora'],
  properties: {
    kind: { const: 'source_index_status' },
    generated_at: { type: 'string', format: 'date-time' },
    corpora: {
      type: 'array',
      maxItems: MAX_CORPORA,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['corpus_id', 'label', 'configured'],
        properties: {
          corpus_id: { type: 'string', pattern: CORPUS_ID.source },
          label: { type: 'string', enum: [...REMOTE_SOURCE_LABELS] },
          trust_domain: { enum: ['public_safe', 'internal', 'secure_local'] },
          configured: { type: 'boolean' },
          retrieval: {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'state'],
            properties: {
              mode: { enum: ['keyword', 'hybrid'] },
              state: { enum: ['ready', 'degraded'] },
            },
          },
          last_refresh: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: {
              status: { type: 'string', pattern: CODE.source },
              completed_at: { type: 'string', format: 'date-time' },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: ['indexed_items', 'chunks', 'embedded_chunks'],
            properties: {
              indexed_items: { type: 'integer', minimum: 0 },
              chunks: { type: 'integer', minimum: 0 },
              embedded_chunks: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
  },
} as const;

/** The error body's schema (OpenAPI `components.schemas.Error`). */
export const REMOTE_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: { type: 'string', description: 'A stable error code.' },
    message: { type: 'string', description: 'A fixed sentence for this code.' },
    ref: { type: 'string', pattern: '^[0-9a-f]{16}$', description: 'Where the owner finds this failure in Olympus\'s log on the computer.' },
  },
} as const;

/** Each remote operation's success output schema: one of its result families. */
export const REMOTE_OUTPUT_SCHEMAS: Readonly<Record<RemoteOperationName, Record<string, unknown>>> = {
  source_answer: { oneOf: [SOURCE_ANSWER_SCHEMA, PENDING_SCHEMA] },
  source_answer_result: {
    oneOf: [SOURCE_ANSWER_SCHEMA, ANONYMOUS_ANSWERED_SCHEMA, ANONYMOUS_NEEDS_CHOICE_SCHEMA, ANONYMOUS_REFUSED_SCHEMA, PENDING_SCHEMA],
  },
  ask_anonymously: { oneOf: [ANONYMOUS_ANSWERED_SCHEMA, ANONYMOUS_NEEDS_CHOICE_SCHEMA, ANONYMOUS_REFUSED_SCHEMA, PENDING_SCHEMA] },
  source_index_status: SOURCE_INDEX_STATUS_SCHEMA,
};

export function remoteOutputSchema(operation: string): Record<string, unknown> | undefined {
  return Object.prototype.hasOwnProperty.call(REMOTE_OUTPUT_SCHEMAS, operation)
    ? REMOTE_OUTPUT_SCHEMAS[operation as RemoteOperationName]
    : undefined;
}

/* ------------------------------------------------------------------ */
/* Scalars                                                             */
/* ------------------------------------------------------------------ */

function isSecretLike(text: string): boolean {
  return secretLabelsInText(text).length > 0;
}

function cleanMultiline(value: string, max: number): string {
  return value.replace(UNSAFE_CHARS, '').slice(0, max);
}

function cleanLine(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return cleaned || undefined;
}

/** A free-text line, or undefined when absent, empty or secret-like. */
function scannedLine(value: unknown, max: number): string | undefined {
  const cleaned = cleanLine(value, max);
  return cleaned && !isSecretLike(cleaned) ? cleaned : undefined;
}

function scannedMultiline(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = cleanMultiline(value, max).trim();
  return cleaned && !isSecretLike(cleaned) ? cleaned : undefined;
}

function wholeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

function dateOnly(value: unknown): string | undefined {
  return iso(value)?.slice(0, 10);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
