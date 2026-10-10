// "Ask anonymously" (owner decisions 2026-10-10): the user asks from their own
// agent ("use Olympus zkAPI to ask ...") through the ask_anonymously tool; it
// is the only way a question goes to zkAPI (the dashboard's own box and the
// automatic consult after a private answer were retired). The typed question is prepared at
// the chosen level (Standard: as written, light cleanup, or the user's own
// instruction; Strict: the writer's general questions under Vitalik's rules),
// checked by the gate (Standard: secrets only; Strict: the thin net under the
// owner's own writer, the full gate under the built-in one), and sent through
// the same zkAPI transport as every consult, with its caps and
// acknowledgements. The reply and exactly what was sent come back. No private
// evidence is involved: the writer sees only the typed question.
//
// The level is asked once (design DESIGN-2026-10-10): with no level in the
// call and none remembered in consult.json (`levelChosen`), nothing is sent and
// the caller is told to ask the user. `remember` stores the choice through
// the composition root's writer; a level in the call without `remember` is a
// one-off override ("ask zkAPI strictly").

import { evaluateConsultRequest, type ConsultWriterContext } from './consult-gate.ts';
import {
  CONSULT_LIGHT_CLEANUP_INSTRUCTION,
  DEFAULT_CONSULT_SETTINGS,
  consultGateOptionsFromSettings,
  consultFrontierModelFor,
  consultModelProvider,
  consultStandardBinding,
  consultWriterIdentity,
  type ConsultCallerProvider,
  type ConsultLevel,
  type ConsultSettingsRead,
  type ConsultStandardMode,
  type ConsultWriterChoice,
} from './consult-settings.ts';
import type { ZkapiConsultOutcome, ZkapiConsultResult } from './consult-transport-zkapi.ts';
import type { ConsultWriterInput, ConsultWriterOutcome } from './consult-writer.ts';

/** The typed question's bound, in characters (the transport also caps it at 8 KiB). */
export const CONSULT_ASK_MAX_CHARS = 4_000;

/** The level as the conversation names it; the file keeps the gate's names. */
export type ConsultAskLevel = 'strict' | 'standard';
export const CONSULT_ASK_LEVELS: readonly ConsultAskLevel[] = Object.freeze(['strict', 'standard']);
export const CONSULT_ASK_CLEANUPS: readonly ConsultStandardMode[] = Object.freeze(['as_written', 'light_cleanup', 'custom']);

export function consultAskLevelToSettings(level: ConsultAskLevel): ConsultLevel {
  return level === 'strict' ? 'general' : 'unnamed';
}

export function consultAskLevelFromSettings(level: ConsultLevel): ConsultAskLevel {
  return level === 'general' ? 'strict' : 'standard';
}

export interface ConsultAskInput {
  readonly question: unknown;
  /** This question's level; absent means the remembered one. */
  readonly level?: ConsultAskLevel;
  /** Standard's preparation for this question; absent means the remembered one. */
  readonly cleanup?: ConsultStandardMode;
  /** Store `level` (and `cleanup`) as the default for later questions. */
  readonly remember?: boolean;
  /** A one-off zkAPI model id; absent means the configured one. Refused when it names the caller's own provider. */
  readonly model?: string;
  /**
   * Who hosts the asking agent, when the surface can tell (OperationCaller
   * .provider): it chooses the model setting (consultFrontierModelFor) and
   * refuses a one-off `model` from the same provider.
   */
  readonly callerProvider?: ConsultCallerProvider;
  /**
   * The caller's cancellation (a remote client disconnecting before hand-off,
   * a handed-off job's deadline). Before dispatch it stops the writer and
   * the session with nothing sent or reserved; after dispatch the reply is
   * waited for by the session, not by this call (Codex review of PR #215).
   */
  readonly signal?: AbortSignal;
}

export interface ConsultAskSendOptions {
  /** The zkAPI model that answers: the one-off `model`, else the one set for the caller's hosting provider. */
  readonly model: string;
  readonly signal?: AbortSignal;
}

export interface ConsultAskDependencies {
  /** consult.json, read once for this question. */
  readonly settings: () => ConsultSettingsRead;
  /** Runs the writer (the owner's own model when chosen, else the built-in one) at the given level. */
  readonly prepare: (input: ConsultWriterInput, writer: ConsultWriterChoice | null, level: ConsultLevel, signal?: AbortSignal) => Promise<ConsultWriterOutcome>;
  /**
   * One zkAPI consult; undefined when no route is configured. `authorize` is
   * the final authorization: the transport calls it immediately before
   * reserving and dispatching (ZkapiSendControl.authorize), and `false`
   * refuses the send with nothing reserved.
   */
  readonly send: (question: string, authorize: () => boolean, options: ConsultAskSendOptions) => Promise<ZkapiConsultResult | undefined>;
  /**
   * Stores a level (and Standard's cleanup) as the default, through the
   * composition root's settings writer. Absent: `remember` is refused.
   */
  readonly remember?: (choice: { level: ConsultLevel; cleanup?: ConsultStandardMode }) => Promise<{ ok: true } | { ok: false; message: string }>;
}

export interface ConsultAskChoiceOptions {
  /** The level the file holds now (the dashboard's setting), offered as the suggestion. */
  readonly suggestedLevel: ConsultAskLevel;
  readonly suggestedCleanup: ConsultStandardMode;
  /** Whether the file holds a custom instruction (so "custom" is a real choice). */
  readonly customInstruction: boolean;
}

export type ConsultAskResult =
  | {
    readonly ok: true;
    readonly sent: string;
    readonly reply: string;
    readonly route: string;
    /** Whether the network address was hidden (Tor): 'hidden', 'visible' (Tor off: payment privacy only), or 'not_verified'. */
    readonly networkIdentity: 'hidden' | 'visible' | 'not_verified';
    readonly level: ConsultAskLevel;
    /** Standard only: how the question was prepared. */
    readonly cleanup?: ConsultStandardMode;
    /** True when the writer rewrote the question (Strict, or Standard light cleanup / custom). */
    readonly rewritten: boolean;
    readonly remembered: boolean;
    /** The zkAPI model that answered. */
    readonly model?: string;
    /** A requested save that failed (the question still went): the user should hear it, or they are asked again next time. */
    readonly note?: string;
  }
  | { readonly ok: false; readonly code: 'needs_choice'; readonly message: string; readonly options: ConsultAskChoiceOptions }
  | {
    readonly ok: false;
    readonly code: string;
    readonly message: string;
    /** The prepared question, when one was prepared (a gate refusal, or a send that failed). */
    readonly sent?: string;
    /**
     * After a send was attempted: whether the question left. `not_sent` (refused
     * before it left), `sent_failed` (the daemon answered with an error;
     * spending may have happened) or `unknown` (it may have reached the
     * provider). Absent when nothing was ever sent to the transport.
     */
    readonly outcome?: ZkapiConsultOutcome;
  };

export const CONSULT_ASK_MESSAGES = Object.freeze({
  empty: 'Type a question first.',
  tooLong: `Keep the question under ${CONSULT_ASK_MAX_CHARS.toLocaleString('en-US')} characters.`,
  settingsInvalid: 'The anonymous answers settings file could not be read, so nothing was sent.',
  declined: 'Your model chose not to send anything.',
  writerFailed: 'Your model could not prepare the question, so nothing was sent.',
  secret: 'Not sent: the question looks like it contains a password, key or token.',
  gateRefused: 'Not sent: at Strict the rewritten question still carried something identifying, so Olympus held it back. Try Standard, or ask more generally.',
  noRoute: 'Set up the zkAPI route first.',
  stale: 'The anonymous answers settings changed while the question was being prepared, so nothing was sent. Ask again.',
  needsChoice: 'Ask the user once: Strict (their model rewrites it into general questions first) or Standard (their words, prepared as they choose: as written, light cleanup, or their own instruction). Then call again with level, and remember=true to keep it.',
  levelInvalid: 'level must be "strict" or "standard".',
  cleanupInvalid: 'cleanup must be "as_written", "light_cleanup" or "custom".',
  cleanupCustomMissing: 'No custom instruction is saved on the Olympus dashboard, so "custom" cannot be used; choose as_written or light_cleanup.',
  rememberUnavailable: 'The choice could not be saved here; it was used for this question only.',
  modelInvalid: 'model must be a zkAPI model id such as anthropic/claude-sonnet-5.5.',
  modelSameProvider: 'Not sent: that model is from the provider that hosts this conversation, so the question could be tied to the user. Name a model from another provider, or leave model out.',
  cancelled: 'The request was cancelled before the question was sent; nothing was charged.',
  tooManyBytes: 'Not sent: the question is over 8 KiB once encoded. Shorten it.',
});

const MAX_MODEL_ID_CHARS = 128;

/**
 * What an Ask binds when it starts (review of PR #209): the file's state and
 * revision, the writer and Standard's mode and instruction. The send is
 * authorized only if consult.json still says the same.
 */
function askBinding(read: ConsultSettingsRead): string {
  const settings = read.state === 'valid' ? read.settings : undefined;
  return JSON.stringify([
    read.state,
    settings?.revision ?? 0,
    consultWriterIdentity(settings?.writer ?? null),
    settings ? consultStandardBinding(settings) : null,
  ]);
}

/** Prepares, checks and sends one typed question. Never throws. */
export async function askAnonymously(input: ConsultAskInput, deps: ConsultAskDependencies): Promise<ConsultAskResult> {
  const typed = typeof input.question === 'string' ? input.question.trim() : '';
  if (!typed) return { ok: false, code: 'question_empty', message: CONSULT_ASK_MESSAGES.empty };
  if (typed.length > CONSULT_ASK_MAX_CHARS) return { ok: false, code: 'question_too_long', message: CONSULT_ASK_MESSAGES.tooLong };
  if (input.level !== undefined && !CONSULT_ASK_LEVELS.includes(input.level)) return { ok: false, code: 'invalid_params', message: CONSULT_ASK_MESSAGES.levelInvalid };
  if (input.cleanup !== undefined && !CONSULT_ASK_CLEANUPS.includes(input.cleanup)) return { ok: false, code: 'invalid_params', message: CONSULT_ASK_MESSAGES.cleanupInvalid };
  if (input.model !== undefined && !validModelId(input.model)) return { ok: false, code: 'invalid_params', message: CONSULT_ASK_MESSAGES.modelInvalid };
  // The cross-provider rule applies to a one-off model too (owner decision
  // 2026-10-10): the provider that holds the conversation never reads the
  // anonymous question.
  if (input.model !== undefined && input.callerProvider !== undefined && consultModelProvider(input.model) === input.callerProvider) {
    return { ok: false, code: 'model_same_provider', message: CONSULT_ASK_MESSAGES.modelSameProvider };
  }
  let read: ConsultSettingsRead;
  try {
    read = deps.settings();
  } catch {
    return { ok: false, code: 'settings_invalid', message: CONSULT_ASK_MESSAGES.settingsInvalid };
  }
  if (read.state === 'invalid') return { ok: false, code: 'settings_invalid', message: CONSULT_ASK_MESSAGES.settingsInvalid };
  let settings = read.state === 'valid' ? read.settings : undefined;
  let stored = consultStandardBinding(settings ?? DEFAULT_CONSULT_SETTINGS);
  const storedLevel: ConsultAskLevel = settings ? consultAskLevelFromSettings(settings.level) : 'standard';

  // The level: this call's, else the remembered one; with neither, ask once.
  let level: ConsultAskLevel;
  if (input.level !== undefined) {
    level = input.level;
  } else if (settings?.levelChosen) {
    level = storedLevel;
  } else {
    return {
      ok: false,
      code: 'needs_choice',
      message: CONSULT_ASK_MESSAGES.needsChoice,
      options: { suggestedLevel: storedLevel, suggestedCleanup: stored.mode, customInstruction: stored.mode === 'custom' },
    };
  }
  // Standard's preparation: this call's, else the file's. "custom" needs the
  // saved instruction; the dashboard is the only place that writes one.
  let cleanup: ConsultStandardMode = stored.mode;
  if (input.cleanup !== undefined) {
    if (input.cleanup === 'custom' && stored.mode !== 'custom') return { ok: false, code: 'invalid_params', message: CONSULT_ASK_MESSAGES.cleanupCustomMissing };
    cleanup = input.cleanup;
  }

  // Remember before sending, so a refused or failed send still keeps the choice.
  let remembered = false;
  let rememberNote: string | undefined;
  if (input.remember === true && input.level !== undefined) {
    if (!deps.remember) {
      rememberNote = CONSULT_ASK_MESSAGES.rememberUnavailable;
    } else {
      let outcome: Awaited<ReturnType<NonNullable<ConsultAskDependencies['remember']>>>;
      try {
        outcome = await deps.remember({ level: consultAskLevelToSettings(level), ...(input.cleanup !== undefined && input.cleanup !== 'custom' ? { cleanup: input.cleanup } : {}) });
      } catch {
        outcome = { ok: false, message: CONSULT_ASK_MESSAGES.rememberUnavailable };
      }
      if (outcome.ok) {
        remembered = true;
        // The file moved: the binding below must see the new revision, and
        // every setting this question is prepared with is re-read from it.
        // A write that landed in between (another conversation's remember,
        // the card) shows as a level or mode other than the one just stored:
        // refused as stale rather than sent under the newer revision with
        // the older preparation (Codex review of PR #215).
        try {
          read = deps.settings();
        } catch {
          return { ok: false, code: 'settings_invalid', message: CONSULT_ASK_MESSAGES.settingsInvalid };
        }
        if (read.state === 'invalid') return { ok: false, code: 'settings_invalid', message: CONSULT_ASK_MESSAGES.settingsInvalid };
        settings = read.state === 'valid' ? read.settings : undefined;
        stored = consultStandardBinding(settings ?? DEFAULT_CONSULT_SETTINGS);
        const rememberedCleanup = input.cleanup !== undefined && input.cleanup !== 'custom' ? input.cleanup : undefined;
        if (!settings?.levelChosen || consultAskLevelFromSettings(settings.level) !== level || (rememberedCleanup !== undefined && stored.mode !== rememberedCleanup)) {
          return { ok: false, code: 'settings_stale', message: CONSULT_ASK_MESSAGES.stale };
        }
        if (input.cleanup === undefined) cleanup = stored.mode;
        else if (input.cleanup === 'custom' && stored.mode !== 'custom') return { ok: false, code: 'settings_stale', message: CONSULT_ASK_MESSAGES.stale };
      } else {
        rememberNote = outcome.message;
      }
    }
  }

  if (input.signal?.aborted) return { ok: false, code: 'cancelled', message: CONSULT_ASK_MESSAGES.cancelled };
  const writer = read.state === 'valid' ? read.settings.writer ?? null : null;
  const strict = level === 'strict';
  let questions: readonly string[];
  let rewritten: boolean;
  if (!strict && cleanup === 'as_written') {
    questions = [typed];
    rewritten = false;
  } else {
    const instruction = strict ? undefined : cleanup === 'custom' ? stored.instruction : CONSULT_LIGHT_CLEANUP_INSTRUCTION;
    let written: ConsultWriterOutcome;
    try {
      written = await deps.prepare(
        { question: typed, answer: '', gaps: [], ...(instruction !== undefined ? { instruction } : { direct: true as const }) },
        writer,
        strict ? 'general' : 'unnamed',
        input.signal,
      );
    } catch {
      written = { kind: 'failed', reason: 'request_failed' };
    }
    if (input.signal?.aborted) return { ok: false, code: 'cancelled', message: CONSULT_ASK_MESSAGES.cancelled };
    if (written.kind === 'declined') return { ok: false, code: 'writer_declined', message: CONSULT_ASK_MESSAGES.declined };
    if (written.kind !== 'questions') return { ok: false, code: 'writer_failed', message: CONSULT_ASK_MESSAGES.writerFailed };
    questions = written.questions;
    rewritten = true;
  }
  const sent = questions.join('\n');
  // The gate. Standard's only outbound rule is secrets (owner decision
  // 2026-10-10): the typed question is the gate's context, so a labelled
  // secret in it ("password: hunter2") stays refused however the request
  // carries it. Strict runs Vitalik's rules: the thin net under the owner's
  // own writer, the full gate under the built-in one, with the typed question
  // as the asked question so copying it is refused.
  const context: ConsultWriterContext = { entries: [{ kind: 'text', text: typed, path: 'writerVisible[]', group: -2 }], overflow: false };
  const verdict = evaluateConsultRequest([...questions], context, {}, {}, strict
    ? { ...consultGateOptionsFromSettings(settings ?? DEFAULT_CONSULT_SETTINGS), level: 'general', askedQuestionTexts: [typed], net: writer ? 'thin' : 'full' }
    : { net: 'secrets' });
  if (verdict.decision !== 'pass') {
    // Within the character bound but over the transport's 8 KiB (multibyte text): a length refusal, not a secret.
    if ([...verdict.reasons].includes('question_too_many_bytes')) return { ok: false, code: 'question_too_long', message: CONSULT_ASK_MESSAGES.tooManyBytes, sent };
    const secret = [...verdict.reasons].some((reason) => /secret/i.test(reason));
    return { ok: false, code: secret || !strict ? 'secret_detected' : 'gate_refused', message: secret || !strict ? CONSULT_ASK_MESSAGES.secret : CONSULT_ASK_MESSAGES.gateRefused, sent };
  }
  const bound = askBinding(read);
  let stale = false;
  const authorize = (): boolean => {
    // Cancelled before dispatch: refused with nothing reserved.
    if (input.signal?.aborted) return false;
    let current: ConsultSettingsRead;
    try {
      current = deps.settings();
    } catch {
      stale = true;
      return false;
    }
    stale = askBinding(current) !== bound;
    return !stale;
  };
  // The question goes to the model set for the caller's hosting provider
  // unless it named one.
  const model = input.model ?? consultFrontierModelFor(settings ?? DEFAULT_CONSULT_SETTINGS, input.callerProvider);
  let result: ZkapiConsultResult | undefined;
  try {
    result = await deps.send(sent, authorize, { model, ...(input.signal ? { signal: input.signal } : {}) });
  } catch {
    result = { ok: false, error: { code: 'internal_error', message: 'The zkAPI session failed inside Olympus.', outcome: 'unknown', networkIdentity: 'not_verified' } };
  }
  if (!result) return { ok: false, code: 'route_not_configured', message: CONSULT_ASK_MESSAGES.noRoute };
  if (stale) return { ok: false, code: 'settings_stale', message: CONSULT_ASK_MESSAGES.stale };
  if (input.signal?.aborted && !result.ok && result.error.outcome === 'not_sent') return { ok: false, code: 'cancelled', message: CONSULT_ASK_MESSAGES.cancelled };
  if (!result.ok) return { ok: false, code: result.error.code, message: rememberNote ? `${result.error.message} ${rememberNote}` : result.error.message, sent, outcome: result.error.outcome };
  return {
    ok: true,
    sent,
    reply: result.text,
    route: result.routeLabel,
    networkIdentity: result.networkIdentity,
    level,
    ...(strict ? {} : { cleanup }),
    rewritten,
    remembered,
    model,
    ...(rememberNote ? { note: rememberNote } : {}),
  };
}

function validModelId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= MAX_MODEL_ID_CHARS && !/[\u0000-\u001F\u007F\s]/.test(value);
}
