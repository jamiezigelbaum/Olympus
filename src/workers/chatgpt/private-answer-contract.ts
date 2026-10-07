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
 *   `{"v":1,"publicKey":"<base64url raw P-256 point>","cap":2}`; responses
 *   carry `status` (connect-relay/shared/private-answer.ts PrivateAnswerWireStatus).
 * - Plaintext of a `ready` response, after decryption: PrivateAnswerPlaintextV1,
 *   or (follow-up collection, below) PrivateAnswerEnvelopeV1.
 * - Open a source on the Mac: `POST <relayOrigin>/private/<jobId>/open` with
 *   `{"v":1,"open":"<token from a citation>"}` → 204 (opened), 410 `gone`
 *   (unknown/expired job or token), 429 `rate_limited`, 403 `forbidden`.
 *
 * AD-2 (design docs/design/frontier-consult-lane.md §A.11, owner-accepted
 * 2026-10-07): the panel protocol's compatibility record, stage C4a.
 *
 * What changed:
 * - Every request body carries the panel's capability, `"cap": 2`,
 *   unconditionally: in both collection phases, whether outside help is on
 *   or off, whatever any consult did. The engine records it at the claim.
 * - The jobs boundary limits tightened on every install
 *   (private-answer-payload.ts): answer 65,536 → 2,700 UTF-16 units,
 *   citations 20 → 4, gaps 10 → 4. Nothing the model layer produces today
 *   is cut (it writes at most 2,700 units, cites at most 4 items and lists
 *   at most 3 gaps plus one unreadable note).
 * - Two collection phases. Phase 1, initial acquisition, is unchanged:
 *   `202 pending` with Retry-After 2, `429`, plaintext `200 failed`, `409`,
 *   `410`, until the first `ready` (first delivery, recorded by the engine).
 *   Phase 2, uniform follow-up, applies to a job whose policy had outside
 *   help on when it was created AND whose claiming panel declared `cap: 2`:
 *   from first delivery, every request by the claiming key gets `200 ready`
 *   with a freshly sealed envelope of exactly 36,864 padded plaintext bytes
 *   (PrivateAnswerEnvelopeV1), whatever any consult did; withdrawal is a
 *   state inside the envelope, never a plaintext `failed`. The only other
 *   responses are infrastructure and identity ones (400, 409, 410 after the
 *   job's policy-bound expiry or eviction, 429, 503), none of which depends
 *   on a consult outcome.
 * - A job with outside help on lives PRIVATE_ANSWER_OUTSIDE_HELP_JOB_TTL_MS
 *   (30 minutes) instead of PRIVATE_ANSWER_JOB_TTL_MS (10); its follow-up
 *   window is min(first delivery + PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS, expiry),
 *   fixed at first delivery and never extended by a remount.
 * - Jobs with outside help off, and jobs claimed by a panel without `cap`,
 *   keep today's behavior exactly: bucket-padded PrivateAnswerPlaintextV1,
 *   stored sealed bytes handed out again, plaintext `failed` on withdrawal.
 *
 * Mixed versions (the engine serves the panel HTML, so a mismatch arises
 * only when the host caches an older widget):
 * - Old panel (no `cap`), new engine: today's behavior, including bucket
 *   padding and plaintext `failed`. No consult is dispatched.
 * - New panel (`cap: 2`), old engine: the old engine reads only `v` and
 *   `publicKey`; its plaintext has no `outside` and no `followSeconds`, which
 *   the panel treats as today's answer: no follow-up polling, no reserved
 *   strip, no errors.
 * The relay is unchanged: it forwards request and response bodies unread
 * (512-byte request cap, 8 MiB response cap).
 */

export const PRIVATE_ANSWER_RESOURCE_URI = 'ui://olympus/private-answer';
export const PRIVATE_ANSWER_META_KEY = 'olympus/privateAnswer';
/** A job lives this long from the search that created it, collected or not. */
export const PRIVATE_ANSWER_JOB_TTL_MS = 10 * 60_000;
/**
 * A job whose policy had outside help on when it was created lives this long
 * instead (design §A.5.4): the lifetime comes from the policy at creation,
 * never from what a consult did.
 */
export const PRIVATE_ANSWER_OUTSIDE_HELP_JOB_TTL_MS = 30 * 60_000;
/**
 * The follow-up window (design §A.5.6): `followUntil = min(firstDeliveredAt +
 * this, job expiry)`, fixed at first delivery. The server computes the
 * seconds left into every envelope; a remount never extends it.
 */
export const PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS = 20 * 60_000;
/**
 * A phase-2 response is held so that it takes at least this long, wall
 * clock (design §A.5.4: a fixed response-time floor, applied because the
 * measured latency of a persistently refused job whose guard reaches the
 * store's content fallback, and of the request in which a job is withdrawn,
 * exceeded the test's noise floor: docs/design/chatgpt-plugin.md,
 * "Follow-up collection", Timing). The floor covers a guard round trip well
 * above the measured ones; a guard slower than it would still show.
 */
export const PRIVATE_ANSWER_FOLLOW_UP_FLOOR_MS = 50;
/** The capability a panel declares in every request body (`cap`); a request without it is capability 1. */
export const PRIVATE_ANSWER_PANEL_CAPABILITY = 2;
export type PrivateAnswerPanelCapability = 1 | 2;
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

/**
 * The outside block inside a follow-up envelope (design §A.5.2, §A.6). `idle`
 * covers nothing triggered, refused, skipped and failed alike, so neither
 * the panel nor anyone watching it can tell them apart. Text, question and
 * route are present only when `appended`; `cut` says the text was shortened.
 */
export interface PrivateAnswerOutsideBlockV1 {
  state: 'idle' | 'pending' | 'appended' | 'paused';
  text?: string;
  cut?: boolean;
  question?: string;
  route?: string;
}

/**
 * Plaintext version 1, extended: what a capability-2 panel decrypts from a
 * follow-up (phase 2) response. `rev` only increases. The first answer and
 * its citations are absent when `state` is `withdrawn`. `followSeconds` is
 * the server-computed time left in the follow-up window (0 once it ends).
 * Every envelope is padded to exactly 36,864 bytes before sealing.
 */
export interface PrivateAnswerEnvelopeV1 {
  v: 1;
  rev: number;
  state: 'answer' | 'withdrawn';
  answer?: string;
  citations?: PrivateAnswerCitation[];
  unanswered?: string[];
  followSeconds: number;
  outside: PrivateAnswerOutsideBlockV1;
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
 * Which of these items a model may read right now: one `true` per item that
 * is still Private-eligible in live state (its tier, the owner's rules and
 * scope, and that it still exists), read when called. Called immediately
 * before every model submission and before an answer is sealed. Anything it
 * cannot vouch for is not eligible.
 */
export type PrivateEvidenceGuard = (items: readonly PrivateEvidenceItem[]) => Promise<readonly boolean[]>;

/**
 * `guard` over `items`, failing closed: a throw, a wrong-length answer, or
 * anything but `true` for an item counts as not eligible.
 */
export async function checkPrivateEvidence(
  guard: PrivateEvidenceGuard | undefined,
  items: readonly PrivateEvidenceItem[],
): Promise<boolean[]> {
  if (items.length === 0) return [];
  if (!guard) return items.map(() => false);
  let answer: readonly boolean[];
  try {
    answer = await guard(items);
  } catch {
    return items.map(() => false);
  }
  if (!Array.isArray(answer) || answer.length !== items.length) return items.map(() => false);
  return answer.map((value) => value === true);
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
