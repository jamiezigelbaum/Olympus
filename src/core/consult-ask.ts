// "Ask anonymously" on the dashboard's Anonymous answers card (owner decision
// 2026-10-10): the user types a question; it is prepared the way Standard is
// set to prepare questions (as written, light cleanup, or the user's own
// instruction), checked for secrets only, and sent through the same zkAPI
// transport as every consult, with its caps and acknowledgements. The reply
// and exactly what was sent come back for the card. It never touches
// ChatGPT, and no private evidence is involved: the writer sees only the
// typed question.

import { evaluateConsultRequest, type ConsultWriterContext } from './consult-gate.ts';
import { consultStandardBinding, consultWriterIdentity, type ConsultSettingsRead, type ConsultWriterChoice } from './consult-settings.ts';
import type { ZkapiConsultResult } from './consult-transport-zkapi.ts';
import type { ConsultWriterInput, ConsultWriterOutcome } from './consult-writer.ts';

/** The typed question's bound, in characters (the transport also caps it at 8 KiB). */
export const CONSULT_ASK_MAX_CHARS = 4_000;

export interface ConsultAskDependencies {
  /** consult.json, read once for this question. */
  readonly settings: () => ConsultSettingsRead;
  /** Runs the writer (the owner's own model when chosen, else the built-in one) under Standard's instruction. */
  readonly prepare: (input: ConsultWriterInput, writer: ConsultWriterChoice | null) => Promise<ConsultWriterOutcome>;
  /**
   * One zkAPI consult with the route's own model; undefined when no route is
   * configured. `authorize` is the final authorization: the transport calls it
   * immediately before reserving and dispatching (ZkapiSendControl.authorize),
   * and `false` refuses the send with nothing reserved.
   */
  readonly send: (question: string, authorize: () => boolean) => Promise<ZkapiConsultResult | undefined>;
}

export type ConsultAskResult =
  | { readonly ok: true; readonly sent: string; readonly reply: string; readonly route: string }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly sent?: string };

export const CONSULT_ASK_MESSAGES = Object.freeze({
  empty: 'Type a question first.',
  tooLong: `Keep the question under ${CONSULT_ASK_MAX_CHARS.toLocaleString('en-US')} characters.`,
  settingsInvalid: 'The anonymous answers settings file could not be read, so nothing was sent.',
  declined: 'Your model chose not to send anything.',
  writerFailed: 'Your model could not prepare the question, so nothing was sent.',
  secret: 'Not sent: the question looks like it contains a password, key or token.',
  noRoute: 'Set up the zkAPI route first.',
  stale: 'The anonymous answers settings changed while the question was being prepared, so nothing was sent. Ask again.',
});

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
export async function askAnonymously(question: unknown, deps: ConsultAskDependencies): Promise<ConsultAskResult> {
  const typed = typeof question === 'string' ? question.trim() : '';
  if (!typed) return { ok: false, code: 'question_empty', message: CONSULT_ASK_MESSAGES.empty };
  if (typed.length > CONSULT_ASK_MAX_CHARS) return { ok: false, code: 'question_too_long', message: CONSULT_ASK_MESSAGES.tooLong };
  let read: ConsultSettingsRead;
  try {
    read = deps.settings();
  } catch {
    return { ok: false, code: 'settings_invalid', message: CONSULT_ASK_MESSAGES.settingsInvalid };
  }
  if (read.state === 'invalid') return { ok: false, code: 'settings_invalid', message: CONSULT_ASK_MESSAGES.settingsInvalid };
  const standard = consultStandardBinding(read.settings);
  let questions: readonly string[];
  if (standard.mode === 'as_written' || standard.instruction === undefined) {
    questions = [typed];
  } else {
    let written: ConsultWriterOutcome;
    try {
      written = await deps.prepare({ question: typed, answer: '', gaps: [], instruction: standard.instruction }, read.state === 'valid' ? read.settings.writer ?? null : null);
    } catch {
      written = { kind: 'failed', reason: 'request_failed' };
    }
    if (written.kind === 'declined') return { ok: false, code: 'writer_declined', message: CONSULT_ASK_MESSAGES.declined };
    if (written.kind !== 'questions') return { ok: false, code: 'writer_failed', message: CONSULT_ASK_MESSAGES.writerFailed };
    questions = written.questions;
  }
  const sent = questions.join('\n');
  // Standard's only outbound rule: secrets (owner decision 2026-10-10). The
  // typed question is the gate's context, so a labelled secret in it
  // ("password: hunter2") stays refused however the request carries it,
  // with or without its label.
  const context: ConsultWriterContext = { entries: [{ kind: 'text', text: typed, path: 'writerVisible[]', group: -2 }], overflow: false };
  const verdict = evaluateConsultRequest([...questions], context, {}, {}, { net: 'secrets' });
  if (verdict.decision !== 'pass') return { ok: false, code: 'secret_detected', message: CONSULT_ASK_MESSAGES.secret, sent };
  const bound = askBinding(read);
  let stale = false;
  const authorize = (): boolean => {
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
  let result: ZkapiConsultResult | undefined;
  try {
    result = await deps.send(sent, authorize);
  } catch {
    result = { ok: false, error: { code: 'internal_error', message: 'The zkAPI session failed inside Olympus.', outcome: 'unknown', networkIdentity: 'not_verified' } };
  }
  if (!result) return { ok: false, code: 'route_not_configured', message: CONSULT_ASK_MESSAGES.noRoute };
  if (stale) return { ok: false, code: 'settings_stale', message: CONSULT_ASK_MESSAGES.stale };
  if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message, sent };
  return { ok: true, sent, reply: result.text, route: result.routeLabel };
}
