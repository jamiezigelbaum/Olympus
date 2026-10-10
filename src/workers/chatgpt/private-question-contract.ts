/**
 * The private question panel contract (v1): a question ChatGPT never sees
 * (owner decision 2026-10-10; design ~/Code/Claude/olympus-zkapi-rethink/
 * DESIGN-2026-10-10.md, "A private question ChatGPT never sees").
 *
 * The user says "use Olympus zkAPI to ask a private question". ChatGPT calls
 * `open_private_question`, which takes no arguments and opens one job; the
 * tool result carries, widget-only, the job id and the engine's public key
 * for it (`_meta[PRIVATE_QUESTION_META_KEY]`, PrivateQuestionMetaV1). The
 * panel (`ui://olympus/private-question`) shows a question field and the
 * Strict/Standard choice, seals what the user typed to that key and posts it
 * to `<relayOrigin>/private/<jobId>/ask`
 * ({"v":1,"publicKey":<panel key>,"iv","ciphertext"}); the relay forwards
 * ciphertext it holds no key for. The engine runs the same ask as the
 * `ask_anonymously` tool (writer, gate, zkAPI, the provider rule, with the
 * caller placed as OpenAI-hosted) and seals the outcome to the panel's key;
 * the panel collects it like a private answer (`POST /private/<jobId>`,
 * pending → ready) and renders it as text only.
 *
 * What the host learns: that a private question was opened at that moment,
 * how long the panel polled, and the panel's rendered height (it reports its
 * size to the host like every MCP Apps widget, so the length class of the
 * outcome is observable: an accepted residual under the owner's 2026-10-07
 * ruling that sealed content is the bar, not invisibility). Never the
 * question, the answer, the level or the model: nothing of those goes back
 * to the host (no tools/call, no widget state, no follow-up message).
 */
import { CONSULT_ASK_MAX_CHARS } from '../../core/consult-ask.ts';

export const PRIVATE_QUESTION_RESOURCE_URI = 'ui://olympus/private-question';
export const PRIVATE_QUESTION_META_KEY = 'olympus/privateQuestion';
/** A job's life: the ask itself may take up to the ask lane's 20 minutes, plus the user's typing. */
export const PRIVATE_QUESTION_JOB_TTL_MS = 30 * 60_000;
export const PRIVATE_QUESTION_MAX_CHARS = CONSULT_ASK_MAX_CHARS;

export type PrivateQuestionLevel = 'strict' | 'standard';
export type PrivateQuestionCleanup = 'as_written' | 'light_cleanup' | 'custom';

/** Widget-only `_meta` of an `open_private_question` result. */
export interface PrivateQuestionMetaV1 {
  v: 1;
  /** `oly2p.<installId>.<secret>`, the same shape as a private answer job. */
  jobId: string;
  /** The engine's P-256 public key for this job (base64url raw point): what the panel seals the question to. */
  askKey: string;
  /** The level the dashboard holds (the panel's default choice). */
  level: PrivateQuestionLevel;
  /** Standard's saved preparation. */
  cleanup: PrivateQuestionCleanup;
  /** Whether a custom instruction is saved (so "custom" is a real choice). */
  customInstruction: boolean;
  maxChars: number;
}

/** What the panel seals to the engine: the question and the choice. */
export interface PrivateQuestionPlaintextV1 {
  v: 1;
  question: string;
  level: PrivateQuestionLevel;
  cleanup?: PrivateQuestionCleanup;
}

/** What the engine seals back: the ask lane's outcome, in the user's words. Rendered as text only. */
export type PrivateQuestionResultV1 =
  | {
    v: 1;
    state: 'answered';
    answer: string;
    /** The zkAPI model that answered. */
    model?: string;
    level: PrivateQuestionLevel;
    cleanup?: PrivateQuestionCleanup;
    /** True when the writer rewrote the question; `sent` is then what left. */
    rewritten: boolean;
    sent?: string;
    route: string;
    networkIdentity: 'hidden' | 'visible' | 'not_verified';
  }
  | {
    v: 1;
    state: 'refused';
    code: string;
    message: string;
    /** After a send was attempted: 'not_sent', 'sent_failed' (spending may have happened) or 'unknown' (it may have reached the provider). */
    outcome?: 'not_sent' | 'sent_failed' | 'unknown';
    /** The prepared question, when one was prepared. */
    sent?: string;
  };
