/**
 * The private answer panel contract (v1): what the UI lane builds against.
 * docs/design/chatgpt-plugin.md, "Private answer panel", is the narrative.
 *
 * - Resource: `ui://olympus/private-answer` (MCP Apps HTML), linked from the
 *   answer tools' and olympus_search's `_meta.ui.resourceUri`. Rendered under
 *   every result; it renders nothing (zero height) unless the result's
 *   `_meta` carries a private match.
 * - Tool result `_meta[PRIVATE_ANSWER_META_KEY]`: PrivateAnswerMetaV1 below.
 *   Widget-only; never the model's context. It carries no key, no token, no
 *   answer text.
 * - Nothing about a private match is model-visible: no count, no state, no
 *   note in `structuredContent` or the text. The model cannot learn whether
 *   Private items match (an existence oracle otherwise).
 * - Endpoint: `POST <relayOrigin>/private/<jobId>` with
 *   `{"v":1,"publicKey":"<base64url raw P-256 point>"}`; responses carry
 *   `status` (connect-relay/shared/private-answer.ts PrivateAnswerWireStatus).
 * - Plaintext of a `ready` response, after decryption: PrivateAnswerPlaintextV1.
 * - Open a source on the Mac: `POST <relayOrigin>/private/<jobId>/open` with
 *   `{"v":1,"open":"<token from a citation>"}` → 204 (opened), 410 `gone`
 *   (unknown/expired job or token), 429 `rate_limited`, 403 `forbidden`.
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

/**
 * How much the private answer reads, chosen by ChatGPT's model through the
 * tool's `detail` argument (never by parsing the question):
 * - `summary` (default): the few most relevant items' best passages, a short
 *   answer, fast.
 * - `full`: the one or two leading items read whole, a longer answer; slower
 *   (its analysis may take up to PRIVATE_ANSWER_FULL_ANALYSIS_TIMEOUT_MS).
 */
export type PrivateAnswerDetail = 'summary' | 'full';

export interface PrivateAnswerMetaV1 {
  v: 1;
  count: number;
  state: PrivateAnswerPanelState;
  /** `oly2p.<installId>.<secret>`; only when state is `ready`. */
  jobId?: string;
  /**
   * `full` when the job reads in depth (the panel may wait longer for it, up
   * to the full analysis deadline); absent for a summary job.
   */
  detail?: 'full';
  /** 0-100; only when state is `model_downloading` and known. */
  percent?: number;
}

export interface PrivateMatchSummary {
  count: number;
  panelState: PrivateAnswerPanelState;
  percent?: number;
  detail?: PrivateAnswerDetail;
}

/** One source of a private answer, as the panel decrypts it. */
export interface PrivateAnswerCitation {
  title?: string;
  source?: string;
  date?: string;
  /** How the panel opens this source, when it can. */
  open?: PrivateAnswerOpenTarget;
}

/**
 * - `mac`: the item's file is on the owner's Mac. `token` is a capability
 *   that opens it there: the panel POSTs `{"v":1,"open":"<token>"}` to
 *   `<relayOrigin>/private/<jobId>/open` (204 when opened). Random, minted
 *   for this job only, expires with it; it names no path.
 * - `web`: an https address that opens the item in its service (for a
 *   Dropbox file, its Dropbox web preview), when it is not on this Mac.
 */
export type PrivateAnswerOpenTarget = { kind: 'mac'; token: string } | { kind: 'web'; url: string };

/** A source as the private model returns it: the local path never enters the plaintext. */
export interface PrivateAnswerSourceCitation {
  title?: string;
  source?: string;
  date?: string;
  url?: string;
  /** The item's file on this computer; the job swaps it for an open token. */
  localPath?: string;
}

/** What the panel decrypts. Rendered as text only, never as HTML. */
export interface PrivateAnswerPlaintextV1 {
  v: 1;
  answer: string;
  /** Only the items the answer cites. The panel lists them on request (a collapsed "Sources"). */
  citations: PrivateAnswerCitation[];
  /** What the private items could not answer: complete sentences, none when the answer is complete. */
  unanswered?: string[];
}

/** One Private search hit as the worker returned it. Opaque here: only the private model reads it. */
export type PrivateEvidenceItem = Readonly<Record<string, unknown>>;

/**
 * Stage costs of one private answer, for the engine's timing log: counts,
 * sizes and milliseconds only, never content.
 */
export interface PrivateAnswerObserver {
  /**
   * The evidence the model reads: items kept, items without readable text,
   * their text bytes, and (`used`) which input items it reads, as indexes
   * into the evidence passed in. The claim-time check revalidates exactly
   * those; without `used`, every input item is revalidated.
   */
  evidence?(stats: { items: number; unreadable: number; bytes: number; used?: readonly number[] }): void;
  /** One model call finished (or failed). */
  modelCall?(call: PrivateAnswerModelCall): void;
}

export interface PrivateAnswerModelCall {
  stage: 'main' | 'audit';
  ms: number;
  promptBytes: number;
  ok: boolean;
  promptTokens?: number;
  promptMs?: number;
  outputTokens?: number;
  outputMs?: number;
}

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
    observe?: PrivateAnswerObserver,
    options?: { detail?: PrivateAnswerDetail },
  ): Promise<{ answer: string; citations: PrivateAnswerSourceCitation[]; unanswered?: string[] }>;
  /**
   * Kill or reset the model runtime (its child process or session). Called
   * when an analysis passes its hard deadline, after the engine has already
   * freed the slot, so a model that ignores `signal` cannot block the next.
   */
  reset?(): void | Promise<void>;
}

/**
 * Thrown by `answerPrivately` when none of the evidence it was given may be
 * read any more (a depth re-read found every picked item refused or gone):
 * the job ends with its no-evidence outcome, and no model was called.
 */
export class NoPrivateEvidenceError extends Error {
  constructor() {
    super('no private evidence may be read');
    this.name = 'NoPrivateEvidenceError';
  }
}

/** No private model on this engine yet: every private match reports `no_model`. */
export const UNAVAILABLE_PRIVATE_ANSWER_MODEL: PrivateAnswerModel = {
  status: () => ({ state: 'no_model' }),
  answerPrivately: async () => {
    throw new Error('no private answer model');
  },
};
