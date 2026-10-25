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
 *   route, notes, refusal messages) and every retained variable identifier
 *   (model, corpus id, job id) is secret-scanned with the release gate's own
 *   scanner (`secretLabelsInText`): the whole original, then the normalized
 *   text, then exactly what is emitted, so a secret cut by a length cap still
 *   counts. Codes and statuses are closed enums.
 * - Errors carry a fixed sentence per code, never the internal message; an
 *   invalid argument is named only when it is one the operation declares.
 * - A source answer is revalidated against its release manifest
 *   (core/release-manifest.ts) when it is collected: every item the analyst
 *   read, cited or not, against the current tiers and release rules. Any
 *   input now Secret, any input now Private when Private derivatives would no
 *   longer be released, or a manifest that is missing or cannot be read
 *   withholds the answer; a cited item gone drops its citation.
 *
 * The local stdio MCP surface, native OpenClaw and the ChatGPT surface do not
 * use this module; their output is unchanged.
 */
import { boundedLogErrorMessage } from './log-redaction.ts';
import { OperationError, type OperationErrorCode } from './operation-error.ts';
import { secretLabelsInText } from './opsec.ts';
import { citationTitleWithParent, PARENT_LABEL_MAX_CHARS } from './parent-label.ts';
import { privateInputReleaseAllowed, type ReleaseCheck, type ReleaseInput, type ReleaseInputVerdict, type ReleaseManifest } from './release-manifest.ts';
import { withoutSecretLocationCoverageNotes } from './secret-location-note.ts';

/** The operations the remote surface serves (core/public-surface.ts V0_4_PUBLIC_REMOTE_MCP_TOOLS). */
export type RemoteOperationName = 'source_answer' | 'source_answer_result' | 'source_index_status' | 'ask_anonymously';

export interface RemoteOutputOptions {
  /**
   * The worker's current tiers and release rules. Set (by the worker) for
   * every remote call; without it (a test context with no tiered stores)
   * source answers are not revalidated.
   */
  releaseCheck?: ReleaseCheck;
  /** The release manifests the call collected (its own answer's, or its job's). */
  releaseManifests?: readonly ReleaseManifest[];
}

const MAX_ANSWER = 64 * 1024;
const MAX_SENT = 16 * 1024;
const MAX_TITLE = 400;
const MAX_ROUTE = 300;
const MAX_MESSAGE = 2_000;
const MAX_CITATIONS = 50;
const MAX_CORPORA = 200;
const JOB_ID = /^saj_[A-Za-z0-9_-]{43}$/;
const PARAM_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CORPUS_ID = /^[a-z0-9_]+(\.[a-z0-9_-]+)+$/i;
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
// C0/C1 controls (tab, newline and carriage return kept), zero-width and bidi controls.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

export const REMOTE_PENDING_MESSAGE = 'Olympus is still working on this and it keeps running. '
  + 'Call source_answer_result with this job_id to get the result; repeat while it says working. Do not ask again.';
/** An item the answer drew on changed tier since it was written; neutral, so it says nothing about which tier. */
export const REMOTE_ANSWER_CHANGED = 'Olympus withheld this answer because an item it drew on has changed privacy level since the answer was written. Ask the question again.';
/** The answer's inputs could not be checked against the current tiers. */
export const REMOTE_ANSWER_UNVERIFIED = 'Olympus withheld this answer because it could not confirm the items it drew on may still be shared. Ask the question again.';
/** The one sentence a remote agent is told when Private items it was not given may answer its question. */
export const REMOTE_PRIVATE_NOTE = 'Your answer is in Olympus on your computer.';
/** The `private_note` field's whole shape: that sentence, then the Open link when the waiting question has an id. */
export const REMOTE_PRIVATE_NOTE_PATTERN = '^Your answer is in Olympus on your computer\\.(?: \\[Open answer\\]\\(olympus://open/private/[A-Za-z0-9_-]{22}\\))?$';
const PRIVATE_ANSWER_ID = /^[A-Za-z0-9_-]{22}$/;
export const REMOTE_ANSWER_WITHHELD = 'Olympus withheld this answer under the owner\'s privacy rules.';
export const REMOTE_REPLY_WITHHELD = 'Olympus withheld the reply because it looked like it contained a password, key or token.';
const REMOTE_REFUSAL_FALLBACK = 'Olympus could not ask anonymously.';
/**
 * Said with an anonymous answer when the asking connection's host is not
 * known, so the question could not be kept from that host's models (the
 * sentence core/consult-ask.ts CONSULT_ASK_MESSAGES.providerUnknown says).
 */
export const REMOTE_PROVIDER_UNKNOWN_NOTE = 'Olympus does not know which company runs this agent, so it could not make sure the answer came from another company\'s model.';
/** What needs_choice tells the agent (the sentence core/consult-ask.ts CONSULT_ASK_MESSAGES.needsChoice says). */
export const REMOTE_NEEDS_CHOICE_MESSAGE = 'Nothing was sent. Ask the user once: Strict (their model rewrites it into general questions first) or Standard (their words, prepared as they choose: as written, light cleanup, or their own instruction). Then call again with level, and remember=true to keep it.';

/* ------------------------------------------------------------------ */
/* Closed vocabularies                                                 */
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

/**
 * Every refusal code an anonymous answer can carry: core/consult-ask.ts's own
 * and the zkAPI transport's (core/consult-transport-zkapi.ts
 * ZkapiConsultErrorCode). Anything else is `refused`. A test keeps this list
 * in step with both sources.
 */
export const REMOTE_REFUSAL_CODES: readonly string[] = Object.freeze([
  'refused',
  // core/consult-ask.ts
  'anonymous_answers_off', 'cancelled', 'gate_refused', 'internal_error', 'invalid_params', 'model_same_provider',
  'question_empty', 'question_too_long', 'route_not_configured', 'secret_detected', 'settings_invalid',
  'settings_stale', 'writer_declined', 'writer_failed',
  // core/consult-transport-zkapi.ts ZkapiConsultErrorCode
  'invalid_question', 'busy', 'acknowledgements_incomplete', 'funding_date_missing', 'funding_date_invalid',
  'note_expired', 'daemon_api_key_missing', 'daemon_not_found', 'tor_not_found', 'unresolved_session',
  'unresolved_session_other_wallet', 'no_unresolved_session', 'stranded_processes', 'daemon_already_running',
  'tor_port_busy', 'tor_bootstrap_failed', 'daemon_start_failed', 'daemon_version_unsupported',
  'daemon_supervisor_unsupported', 'relay_mismatch', 'key_reuse_on', 'key_reuse_unverified', 'daemon_keyless',
  'daemon_identity_failed', 'daemon_api_key_rejected', 'session_process_exited', 'confinement_self_test_failed', 'confinement_unavailable',
  'policy_unavailable', 'model_unavailable', 'daily_cap_reached', 'spend_cap_reached', 'state_unavailable',
  'timeout', 'aborted', 'redirect_refused', 'response_too_large', 'invalid_response', 'daemon_error',
  'transport_failed', 'teardown_incomplete', 'authorization_refused', 'session_spent',
].filter((code, index, all) => all.indexOf(code) === index));

/** The zkAPI daemon's own error codes (core/consult-transport-zkapi.ts ZkapiDaemonErrorCode). */
export const REMOTE_DAEMON_CODES: readonly string[] = Object.freeze([
  'busy', 'request_cancelled', 'funding_required', 'model_budget_unavailable', 'model_policy_unavailable',
  'invalid_model', 'anonymous_access_failed', 'upstream_error', 'invalid_upstream_response', 'withdrawal_pending',
  'wallet_conflict', 'invalid_request_error', 'invalid_body', 'testnet_password_required', 'invalid_api_key',
  'local_connection_required', 'browser_origin_denied', 'unrecognized',
]);

/** A connector-store sync run's status (workers/connector-store/local-index.ts). */
const REFRESH_STATUSES: readonly string[] = Object.freeze(['running', 'completed', 'failed']);
const TRUST_DOMAINS: readonly string[] = Object.freeze(['public_safe', 'internal', 'secure_local']);
const RETRIEVAL_MODES: readonly string[] = Object.freeze(['keyword', 'hybrid']);
const RETRIEVAL_STATES: readonly string[] = Object.freeze(['ready', 'degraded']);
const NETWORK_IDENTITIES: readonly string[] = Object.freeze(['hidden', 'visible', 'not_verified']);
const CLEANUPS: readonly string[] = Object.freeze(['as_written', 'light_cleanup', 'custom']);
const OUTCOMES: readonly string[] = Object.freeze(['not_sent', 'sent_failed', 'unknown']);

function oneOf(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}

/* ------------------------------------------------------------------ */
/* The remote view of each operation's parameters                      */
/* ------------------------------------------------------------------ */

/**
 * Parameters the remote surface does not serve, per operation: they are not
 * advertised there and a call that passes one is refused by name. Their
 * output (sender counts, ledgers, item listings) never reaches a remote agent.
 */
export const REMOTE_WITHHELD_PARAMS: Readonly<Partial<Record<RemoteOperationName, readonly string[]>>> = {
  source_index_status: [
    'conversation_id',
    'include_sender_aggregation',
    'max_senders',
    'include_readiness_ledger',
    'include_ingestion_ledger',
    'include_items',
    'max_items',
    'query',
  ],
};

const REMOTE_DESCRIPTIONS: Readonly<Partial<Record<RemoteOperationName, string>>> = {
  source_index_status: [
    'Inspect source-index corpus status: each corpus\'s refresh status and aggregate counts.',
    'Read-only: it never returns item metadata, sender counts, ledgers, source text, vectors or credentials.',
    'Legacy extraction filter fields are refused on the connector-store status surface rather than silently returning whole-corpus counts.',
  ].join(' '),
};

function withheldParams(operation: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(REMOTE_WITHHELD_PARAMS, operation)
    ? REMOTE_WITHHELD_PARAMS[operation as RemoteOperationName] ?? []
    : [];
}

/** The parameters an operation declares on the remote surface. */
export function remoteDeclaredParams(operation: string, declared: readonly string[]): string[] {
  const withheld = withheldParams(operation);
  return declared.filter((name) => !withheld.includes(name));
}

/** The remote surface's description of an operation. */
export function remoteToolDescription(operation: string, description: string): string {
  return Object.prototype.hasOwnProperty.call(REMOTE_DESCRIPTIONS, operation)
    ? REMOTE_DESCRIPTIONS[operation as RemoteOperationName] ?? description
    : description;
}

/** An operation's input schema on the remote surface: withheld parameters removed. */
export function remoteToolSchema(operation: string, schema: Record<string, unknown>): Record<string, unknown> {
  const withheld = withheldParams(operation);
  if (withheld.length === 0) return schema;
  const properties = asRecord(schema.properties) ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return {
    ...schema,
    properties: Object.fromEntries(Object.entries(properties).filter(([name]) => !withheld.includes(name))),
    required: required.filter((name) => typeof name === 'string' && !withheld.includes(name)),
  };
}

/** The first withheld parameter a call passes (by name order), or undefined. */
export function remoteWithheldParam(operation: string, args: Readonly<Record<string, unknown>>): string | undefined {
  const withheld = withheldParams(operation);
  return Object.keys(args).filter((name) => withheld.includes(name)).sort()[0];
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
  // Minted by Olympus (core/source-answer-jobs.ts, never scanner-shaped), and scanned again here.
  if (typeof record.job_id !== 'string' || !JOB_ID.test(record.job_id) || isSecretLike(record.job_id)) {
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
  let dropped: ReadonlySet<number> = new Set();
  if (options.releaseCheck) {
    const recheck = recheckRelease(evidence, options.releaseManifests ?? [], options.releaseCheck);
    if ('withhold' in recheck) return withheldAnswer(recheck.withhold);
    dropped = recheck.dropped;
  }
  // The raw answer is scanned whole as well: only the Secret note (fixed text) is taken out first.
  if (isSecretLike(record.answer)) return withheldAnswer(REMOTE_ANSWER_WITHHELD);
  const answer = scannedText(withoutSecretLocationCoverageNotes(record.answer), MAX_ANSWER, 'multiline');
  if (answer.secret) return withheldAnswer(REMOTE_ANSWER_WITHHELD);
  const citations: Array<Record<string, unknown>> = [];
  evidence.forEach((entry, index) => {
    if (dropped.has(index) || citations.length >= MAX_CITATIONS) return;
    citations.push(citationOutput(entry));
  });
  return {
    kind: 'source_answer',
    status: 'answered',
    answer: answer.text ?? '',
    citations,
  };
}

/**
 * A remote output with REMOTE_PRIVATE_NOTE added, when it is an answered
 * source answer: the answer left Private out and the local probe found
 * matching Private items (core/remote-private-part.ts). The fixed sentence
 * and nothing else about them. Any other output is returned unchanged.
 */
export function withRemotePrivateNote(output: Record<string, unknown>, answerId?: string): Record<string, unknown> {
  return output.kind === 'source_answer' && output.status === 'answered'
    ? { ...output, private_note: remotePrivateNote(answerId) }
    : output;
}

/**
 * The `private_note` text: REMOTE_PRIVATE_NOTE and, for a well-formed waiting
 * question id, the one Open link to it. The source answer and the evidence
 * search (workers/remote-search.ts) both put exactly this in front of an agent.
 */
export function remotePrivateNote(answerId?: string): string {
  return answerId && PRIVATE_ANSWER_ID.test(answerId) ? `${REMOTE_PRIVATE_NOTE} [Open answer](olympus://open/private/${answerId})` : REMOTE_PRIVATE_NOTE;
}

function withheldAnswer(message: string): Record<string, unknown> {
  return { kind: 'source_answer', status: 'withheld', answer: message, citations: [] };
}

/**
 * Revalidates an answer against its release manifests: withholds when one is
 * missing, cannot be read, names an input now Secret or unprovable, names an
 * input now Private when Private derivatives would not be released now, or
 * does not cover a cited item, or drew on a child item whose parent is gone.
 * Otherwise the citations of gone items are dropped.
 */
function recheckRelease(
  evidence: readonly Record<string, unknown>[],
  manifests: readonly ReleaseManifest[],
  check: ReleaseCheck,
): { withhold: string } | { dropped: ReadonlySet<number> } {
  if (manifests.length === 0) {
    console.error('[olympus:remote] release_manifest_missing');
    return { withhold: REMOTE_ANSWER_UNVERIFIED };
  }
  const inputs: Array<{ input: ReleaseInput; manifest: ReleaseManifest }> = manifests
    .flatMap((manifest) => manifest.inputs.map((input) => ({ input, manifest })));
  let verdicts: readonly ReleaseInputVerdict[];
  let postureNow: 'allow' | 'approval';
  try {
    verdicts = check.inputs(inputs.map(({ input }) => input));
    if (verdicts.length !== inputs.length) throw new Error('release check returned the wrong number of verdicts');
    postureNow = check.secureDerivativeDefault();
  } catch (error) {
    console.error(`[olympus:remote] release_check_failed error_message=${boundedLogErrorMessage(error)}`);
    return { withhold: REMOTE_ANSWER_UNVERIFIED };
  }
  if (verdicts.some((verdict) => verdict.tier === 'secret')) return { withhold: REMOTE_ANSWER_CHANGED };
  if (verdicts.some((verdict) => verdict.tier === 'unknown')) return { withhold: REMOTE_ANSWER_UNVERIFIED };
  // An answer that drew on a child whose parent is gone is withheld whole: what it said of the child
  // may be in its prose, and a dropped citation would leave that standing.
  if (verdicts.some((verdict) => verdict.hiddenByParent === true)) return { withhold: REMOTE_ANSWER_UNVERIFIED };
  for (const [index, { input, manifest }] of inputs.entries()) {
    const verdict = verdicts[index]!;
    // A parent label's names are a dependency of the answer, never a cited item: the prose may carry
    // the parent's subject and sender, so a dependency that is gone leaves nothing to drop. It
    // withholds the whole answer.
    if (input.layer === 'names' && verdict.gone) return { withhold: REMOTE_ANSWER_UNVERIFIED };
    if (!privateInputReleaseAllowed(input, verdict, manifest.constraints, postureNow)) return { withhold: input.privateAtAnswer ? REMOTE_ANSWER_WITHHELD : REMOTE_ANSWER_CHANGED };
  }
  const dropped = new Set<number>();
  for (const [index, entry] of evidence.entries()) {
    const matches = inputs.flatMap(({ input }, position) => (citesInput(entry, input) ? [verdicts[position]!] : []));
    if (matches.length === 0) {
      console.error('[olympus:remote] release_manifest_incomplete');
      return { withhold: REMOTE_ANSWER_UNVERIFIED };
    }
    if (matches.some((verdict) => verdict.gone)) dropped.add(index);
  }
  return { dropped };
}

/** A citation names its corpus, provider, conversation and item, never its account. */
function citesInput(entry: Record<string, unknown>, input: ReleaseInput): boolean {
  // A parent label's names-layer input is a dependency of the answer, never the item a citation names.
  return input.layer !== 'names'
    && entry.corpus_id === input.corpusId
    && entry.provider === input.provider
    && entry.provider_item_id === input.providerItemId
    && (typeof entry.provider_conversation_id === 'string' && entry.provider_conversation_id ? entry.provider_conversation_id : undefined)
      === input.providerConversationId;
}

/** Label, title and date only: no provider identifiers, URIs, spans or trust fields. */
function citationOutput(entry: Record<string, unknown>): Record<string, unknown> {
  const title = scannedText(entry.title, MAX_TITLE, 'line');
  const date = dateOnly(entry.authored_at) ?? dateOnly(entry.updated_at);
  // A child's parent rides in the title text ("lease.pdf, in 'Flat' from Alice"), scanned and capped
  // like the title, so the output schema and the tool lists are unchanged.
  const parent = keptText(entry.parent_label, PARENT_LABEL_MAX_CHARS, 'line');
  const composed: { text?: string; secret: boolean } = title.secret
    ? { secret: true }
    : scannedText(citationTitleWithParent(title.text, parent), MAX_TITLE, 'line');
  return {
    label: sourceLabel(entry.provider, entry.family),
    ...(composed.text && !composed.secret ? { title: composed.text } : {}),
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
    const reply = scannedText(record.reply, MAX_ANSWER, 'multiline');
    const sent = keptText(record.sent, MAX_SENT, 'multiline');
    const route = keptText(record.route, MAX_ROUTE, 'line');
    const note = keptText(record.note, MAX_MESSAGE, 'line');
    const model = typeof record.model === 'string' && MODEL_ID.test(record.model) && !isSecretLike(record.model) ? record.model : undefined;
    const cleanup = oneOf(record.cleanup, CLEANUPS);
    return {
      kind: 'anonymous_answer',
      status: 'answered',
      reply: reply.secret ? REMOTE_REPLY_WITHHELD : reply.text ?? '',
      level: record.level === 'strict' ? 'strict' : 'standard',
      rewritten: record.rewritten === true,
      remembered: record.remembered === true,
      // Anonymous only when the network address was hidden (Tor, verified).
      network_identity: oneOf(record.networkIdentity, NETWORK_IDENTITIES) ?? 'not_verified',
      ...(cleanup ? { cleanup } : {}),
      ...(model ? { model } : {}),
      ...(route ? { route } : {}),
      ...(sent ? { sent } : {}),
      ...(note ? { note } : {}),
      // A fixed sentence, never the worker's text.
      ...(typeof record.providerNote === 'string' ? { provider_note: REMOTE_PROVIDER_UNKNOWN_NOTE } : {}),
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
        suggested_cleanup: oneOf(options?.suggestedCleanup, CLEANUPS) ?? 'as_written',
        custom_instruction: options?.customInstruction === true,
      },
    };
  }
  const sent = keptText(record.sent, MAX_SENT, 'multiline');
  const outcome = oneOf(record.outcome, OUTCOMES);
  const daemonCode = oneOf(record.daemonCode, REMOTE_DAEMON_CODES);
  return {
    kind: 'anonymous_answer',
    status: 'refused',
    code: oneOf(record.code, REMOTE_REFUSAL_CODES) ?? 'refused',
    message: keptText(record.message, MAX_MESSAGE, 'line') ?? REMOTE_REFUSAL_FALLBACK,
    // Whether the question left: absent means it was never handed to the
    // transport; `not_sent` refused before it left; `sent_failed` or
    // `unknown` may have spent from the user's zkAPI balance.
    ...(outcome ? { outcome } : {}),
    ...(daemonCode ? { daemon_code: daemonCode } : {}),
    ...(sent ? { sent } : {}),
  };
}

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
    if (!corpus || typeof corpus.corpus_id !== 'string' || corpus.corpus_id.length > 128
      || !CORPUS_ID.test(corpus.corpus_id) || isSecretLike(corpus.corpus_id)) continue;
    const retrieval = asRecord(corpus.retrieval);
    const mode = oneOf(retrieval?.servable_mode, RETRIEVAL_MODES);
    const state = oneOf(retrieval?.state, RETRIEVAL_STATES);
    const refresh = asRecord(corpus.last_refresh);
    const refreshStatus = oneOf(refresh?.status, REFRESH_STATUSES);
    const completedAt = iso(refresh?.completed_at);
    const counts = asRecord(corpus.counts);
    const trustDomain = oneOf(corpus.trust_domain, TRUST_DOMAINS);
    corpora.push({
      corpus_id: corpus.corpus_id,
      label: sourceLabel(corpus.provider, corpus.family),
      ...(trustDomain ? { trust_domain: trustDomain } : {}),
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

/** Failures before any operation runs: credentials, paths, methods, bodies. */
export type RemoteTransportErrorCode =
  | 'unauthorized'
  | 'invalid_token'
  | 'remote_connections_unavailable'
  | 'not_found'
  | 'method_not_allowed'
  | 'unsupported_media_type'
  | 'payload_too_large';

export type RemoteErrorCode =
  | OperationErrorCode
  | RemoteTransportErrorCode
  | 'internal_error'
  | 'unknown_operation'
  | 'operation_unavailable'
  /** Only the relay says it, for any tool call while the install is offline (connect-relay/shared/offline-result.ts). */
  | 'olympus_offline';

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
  unauthorized: 'A connection token is required.',
  invalid_token: 'The connection token is not valid or has been revoked.',
  remote_connections_unavailable: 'Olympus could not check the connection token. Try again later.',
  not_found: 'There is nothing at this path.',
  method_not_allowed: 'That HTTP method is not allowed here.',
  unsupported_media_type: 'The request body must be JSON (Content-Type: application/json).',
  payload_too_large: 'The request body is too large.',
  // The relay's sentence names a coarse "last seen" when it has one (connect-relay/shared/offline-result.ts).
  olympus_offline: 'Olympus is off; try again later.',
};

/** How long a busy refusal asks an agent to wait (the body's retry_after_seconds and the HTTP Retry-After). */
export const SOURCE_ANSWER_BUSY_RETRY_AFTER_SECONDS = 30;

/** Codes that always ask the agent to come back after a while. */
const RETRY_AFTER_SECONDS: Readonly<Partial<Record<RemoteErrorCode, number>>> = {
  source_answer_busy: SOURCE_ANSWER_BUSY_RETRY_AFTER_SECONDS,
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

export interface RemoteErrorBody {
  error: RemoteErrorCode;
  message: string;
  /** Where the owner finds this failure in Olympus's log on the computer. */
  ref?: string;
  /** The argument at fault: only ever one the operation declares on the remote surface. */
  param?: string;
  /** Seconds to wait before trying again (busy, or offline at the relay); also sent as HTTP Retry-After. */
  retry_after_seconds?: number;
}

/** A body's retry_after_seconds, when it is a well-formed one (for the HTTP Retry-After header). */
export function remoteRetryAfterSeconds(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as { retry_after_seconds?: unknown }).retry_after_seconds;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 86_400 ? value : undefined;
}

export interface RemoteErrorOptions {
  /** The operation's declared remote parameters: the only names an error may give. */
  declaredParams?: readonly string[];
}

export function remoteErrorCode(error: unknown): RemoteErrorCode {
  if (error instanceof OperationError && Object.prototype.hasOwnProperty.call(REMOTE_ERROR_TEXT, error.code)) return error.code;
  return 'internal_error';
}

/** A fixed sentence per code; the internal message never leaves. */
export function remoteErrorOutput(error: unknown, options: RemoteErrorOptions = {}): RemoteErrorBody {
  const code = remoteErrorCode(error);
  if (code === 'invalid_params' && options.declaredParams && error instanceof OperationError) {
    const param = namedParam(error.message, options.declaredParams);
    if (param) return { error: code, message: invalidParamMessage(param), param };
  }
  const retryAfter = RETRY_AFTER_SECONDS[code];
  if (retryAfter !== undefined) return { error: code, message: REMOTE_ERROR_TEXT[code], retry_after_seconds: retryAfter };
  if (!REFERENCED_ERROR_CODES.has(code)) return { error: code, message: REMOTE_ERROR_TEXT[code] };
  const ref = mintErrorRef();
  const errorClass = error instanceof Error ? error.name : typeof error;
  console.error(`[olympus:remote] tool_error code=${code} ref=${ref} class=${JSON.stringify(errorClass)} error_message=${boundedLogErrorMessage(error)}`);
  return { error: code, message: REMOTE_ERROR_TEXT[code], ref };
}

/** A surface-level or transport refusal (no such operation, switched off, bad credential or request). */
export function remoteSurfaceErrorOutput(code: 'unknown_operation' | 'operation_unavailable' | RemoteTransportErrorCode | 'invalid_request'): RemoteErrorBody {
  return { error: code, message: REMOTE_ERROR_TEXT[code] };
}

/** A withheld parameter, refused by name (it is one the operation declares elsewhere). */
export function remoteWithheldParamOutput(param: string): RemoteErrorBody {
  if (!PARAM_NAME.test(param)) return { error: 'invalid_params', message: REMOTE_ERROR_TEXT.invalid_params };
  return {
    error: 'invalid_params',
    message: `The ${param} argument is not available to remote agents. Remove it and try again.`,
    param,
  };
}

function invalidParamMessage(param: string): string {
  return `The ${param} argument was not valid. Check it against the tool's schema and try again.`;
}

/** The declared name the internal message mentions first, as a whole word; never anything else. */
function namedParam(message: string, declared: readonly string[]): string | undefined {
  let best: { name: string; at: number } | undefined;
  for (const name of declared) {
    if (!PARAM_NAME.test(name)) continue;
    const match = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).exec(message);
    if (match && (!best || match.index < best.at)) best = { name, at: match.index };
  }
  return best?.name;
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
  description: 'A source answer: give the answer with its citations. "withheld" carries a fixed sentence to pass on instead. When private_note is present, pass it on as written.',
  additionalProperties: false,
  required: ['kind', 'status', 'answer', 'citations'],
  properties: {
    kind: { const: 'source_answer' },
    status: { enum: ['answered', 'withheld'] },
    answer: { type: 'string', maxLength: MAX_ANSWER },
    citations: { type: 'array', maxItems: MAX_CITATIONS, items: CITATION_SCHEMA },
    private_note: { type: 'string', pattern: REMOTE_PRIVATE_NOTE_PATTERN },
  },
} as const;

const ANONYMOUS_ANSWERED_SCHEMA = {
  type: 'object',
  description: 'The anonymous reply. When rewritten is true, say the question was rewritten first and offer to show "sent". When provider_note is present, pass it on as written.',
  additionalProperties: false,
  required: ['kind', 'status', 'reply', 'level', 'rewritten', 'remembered', 'network_identity'],
  properties: {
    kind: { const: 'anonymous_answer' },
    status: { const: 'answered' },
    reply: { type: 'string', maxLength: MAX_ANSWER },
    level: { enum: ['strict', 'standard'] },
    rewritten: { type: 'boolean' },
    remembered: { type: 'boolean' },
    network_identity: { enum: [...NETWORK_IDENTITIES] },
    cleanup: { enum: [...CLEANUPS] },
    model: { type: 'string', pattern: MODEL_ID.source },
    route: { type: 'string', maxLength: MAX_ROUTE },
    sent: { type: 'string', maxLength: MAX_SENT },
    note: { type: 'string', maxLength: MAX_MESSAGE },
    provider_note: { const: REMOTE_PROVIDER_UNKNOWN_NOTE },
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
        suggested_cleanup: { enum: [...CLEANUPS] },
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
    code: { enum: [...REMOTE_REFUSAL_CODES] },
    message: { type: 'string', maxLength: MAX_MESSAGE },
    outcome: { enum: [...OUTCOMES] },
    daemon_code: { enum: [...REMOTE_DAEMON_CODES] },
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
          corpus_id: { type: 'string', pattern: CORPUS_ID.source, maxLength: 128 },
          label: { type: 'string', enum: [...REMOTE_SOURCE_LABELS] },
          trust_domain: { enum: [...TRUST_DOMAINS] },
          configured: { type: 'boolean' },
          retrieval: {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'state'],
            properties: {
              mode: { enum: [...RETRIEVAL_MODES] },
              state: { enum: [...RETRIEVAL_STATES] },
            },
          },
          last_refresh: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: {
              status: { enum: [...REFRESH_STATUSES] },
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

/** The error body's schema (OpenAPI `components.schemas.Error`): every remote failure has this shape. */
export const REMOTE_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['error', 'message'],
  properties: {
    error: { enum: [...REMOTE_ERROR_CODES], description: 'A stable error code.' },
    message: { type: 'string', description: 'A fixed sentence for this code.' },
    ref: { type: 'string', pattern: '^[0-9a-f]{16}$', description: 'Where the owner finds this failure in Olympus\'s log on the computer.' },
    param: { type: 'string', pattern: PARAM_NAME.source, description: 'The argument at fault, when it is one the operation declares.' },
    retry_after_seconds: {
      type: 'integer',
      minimum: 1,
      maximum: 86400,
      description: 'Seconds to wait before trying again, when Olympus is busy or offline; also sent as the HTTP Retry-After header.',
    },
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
/* Scanning and scalars                                                */
/* ------------------------------------------------------------------ */

function isSecretLike(text: string): boolean {
  return secretLabelsInText(text).length > 0;
}

/**
 * A free-text field, normalized and capped. `secret` when the whole original,
 * the whole normalized text, or the emitted (capped) text is secret-like, so
 * a secret straddling the cap never leaves as a prefix. `line` folds
 * whitespace to single spaces; `multiline` keeps line breaks.
 */
function scannedText(value: unknown, max: number, mode: 'line' | 'multiline'): { text?: string; secret: boolean } {
  if (typeof value !== 'string') return { secret: false };
  if (isSecretLike(value)) return { secret: true };
  const normalized = mode === 'line'
    ? value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim()
    : value.replace(UNSAFE_CHARS, '');
  if (isSecretLike(normalized)) return { secret: true };
  const emitted = mode === 'line' ? normalized.slice(0, max).trim() : normalized.slice(0, max);
  if (isSecretLike(emitted)) return { secret: true };
  return emitted ? { text: emitted, secret: false } : { secret: false };
}

/** An optional free-text field: undefined when absent, empty or secret-like. */
function keptText(value: unknown, max: number, mode: 'line' | 'multiline'): string | undefined {
  const scanned = scannedText(value, max, mode);
  const text = mode === 'multiline' ? scanned.text?.trim() : scanned.text;
  return text && !scanned.secret ? text : undefined;
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
