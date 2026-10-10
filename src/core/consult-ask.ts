// "Ask anonymously" on the dashboard's Anonymous answers card (owner decision
// 2026-10-10): the user types a question; it is prepared the way Standard is
// set to prepare questions (as written, light cleanup, or the user's own
// instruction), checked for secrets only, and sent through the same zkAPI
// transport as every consult, with its caps and acknowledgements. The reply
// and exactly what was sent come back for the card. It never touches
// ChatGPT, and no private evidence is involved: the writer sees only the
// typed question.

import { evaluateConsultRequest } from './consult-gate.ts';
import { consultStandardBinding, type ConsultSettingsRead, type ConsultWriterChoice } from './consult-settings.ts';
import type { ZkapiConsultResult } from './consult-transport-zkapi.ts';
import type { ConsultWriterInput, ConsultWriterOutcome } from './consult-writer.ts';

/** The typed question's bound, in characters (the transport also caps it at 8 KiB). */
export const CONSULT_ASK_MAX_CHARS = 4_000;

export interface ConsultAskDependencies {
  /** consult.json, read once for this question. */
  readonly settings: () => ConsultSettingsRead;
  /** Runs the writer (the owner's own model when chosen, else the built-in one) under Standard's instruction. */
  readonly prepare: (input: ConsultWriterInput, writer: ConsultWriterChoice | null) => Promise<ConsultWriterOutcome>;
  /** One zkAPI consult with the route's own model; undefined when no route is configured. */
  readonly send: (question: string) => Promise<ZkapiConsultResult | undefined>;
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
});

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
  // Standard's only outbound rule: secrets (owner decision 2026-10-10).
  const verdict = evaluateConsultRequest([...questions], { entries: [], overflow: false }, {}, {}, { net: 'secrets' });
  if (verdict.decision !== 'pass') return { ok: false, code: 'secret_detected', message: CONSULT_ASK_MESSAGES.secret, sent };
  let result: ZkapiConsultResult | undefined;
  try {
    result = await deps.send(sent);
  } catch {
    result = { ok: false, error: { code: 'internal_error', message: 'The zkAPI session failed inside Olympus.', outcome: 'unknown', networkIdentity: 'not_verified' } };
  }
  if (!result) return { ok: false, code: 'route_not_configured', message: CONSULT_ASK_MESSAGES.noRoute };
  if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message, sent };
  return { ok: true, sent, reply: result.text, route: result.routeLabel };
}
