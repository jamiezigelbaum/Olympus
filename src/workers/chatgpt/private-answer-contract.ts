/**
 * The private answer panel contract (v1): what the UI lane builds against.
 * docs/design/chatgpt-plugin.md, "Private answer panel", is the narrative.
 *
 * - Resource: `ui://olympus/private-answer` (MCP Apps HTML), linked from the
 *   answer tools' `_meta.ui.resourceUri`. Rendered under every answer; it
 *   shows nothing unless the result's `_meta` carries a private match.
 * - Tool result `_meta[PRIVATE_ANSWER_META_KEY]`: PrivateAnswerMetaV1 below.
 *   Widget-only; never the model's context. It carries no key, no token, no
 *   answer text.
 * - Tool result `structuredContent.privateMatch`: { count, panelState } (the
 *   model may see it; counts and state only).
 * - Endpoint: `POST <relayOrigin>/private/<jobId>` with
 *   `{"v":1,"publicKey":"<base64url raw P-256 point>"}`; responses carry
 *   `status` (connect-relay/shared/private-answer.ts PrivateAnswerWireStatus).
 * - Plaintext of a `ready` response, after decryption: PrivateAnswerPlaintextV1.
 */

export const PRIVATE_ANSWER_RESOURCE_URI = 'ui://olympus/private-answer';
export const PRIVATE_ANSWER_META_KEY = 'olympus/privateAnswer';
/** A job lives this long from the search that created it, collected or not. */
export const PRIVATE_ANSWER_JOB_TTL_MS = 10 * 60_000;
/** The count is "N private items match", capped: beyond this the panel says "N+". */
export const PRIVATE_MATCH_COUNT_CAP = 50;

/**
 * - `ready`: a private model is ready; `jobId` is set and the panel may offer
 *   "Show private answer".
 * - `no_model`: no private answer model is set up; counts only, no job.
 * - `model_downloading`: the built-in private model is still downloading
 *   (`percent` when known); counts only, no job.
 */
export type PrivateAnswerPanelState = 'ready' | 'no_model' | 'model_downloading';

export interface PrivateAnswerMetaV1 {
  v: 1;
  count: number;
  state: PrivateAnswerPanelState;
  /** `oly2p.<installId>.<secret>`; only when state is `ready`. */
  jobId?: string;
  /** 0-100; only when state is `model_downloading` and known. */
  percent?: number;
}

export interface PrivateMatchSummary {
  count: number;
  panelState: PrivateAnswerPanelState;
  percent?: number;
}

export interface PrivateAnswerCitation {
  title?: string;
  source?: string;
  date?: string;
}

/** What the panel decrypts. Rendered as text only, never as HTML. */
export interface PrivateAnswerPlaintextV1 {
  v: 1;
  answer: string;
  citations: PrivateAnswerCitation[];
}

/** One Private search hit as the worker returned it. Opaque here: only the private model reads it. */
export type PrivateEvidenceItem = Readonly<Record<string, unknown>>;

/**
 * The private answer model, provided by the private-model lane (an
 * AnalystModel named `built_in`). This lane codes against this interface and
 * ships an unavailable stub until that lane lands.
 */
export interface PrivateAnswerModel {
  status(): { state: 'ready' } | { state: 'no_model' } | { state: 'model_downloading'; percent?: number };
  answerPrivately(
    question: string,
    evidence: readonly PrivateEvidenceItem[],
    signal?: AbortSignal,
  ): Promise<{ answer: string; citations: PrivateAnswerCitation[] }>;
}

/** No private model on this engine yet: every private match reports `no_model`. */
export const UNAVAILABLE_PRIVATE_ANSWER_MODEL: PrivateAnswerModel = {
  status: () => ({ state: 'no_model' }),
  answerPrivately: async () => {
    throw new Error('no private answer model');
  },
};
