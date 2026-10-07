/**
 * One-time private-answer jobs and the engine's `/private/<id>` endpoint.
 *
 * A ChatGPT answer whose question matches Private items creates a job here
 * (when a private model is ready) at the moment its tool result is built, so
 * the id exists only once ChatGPT can see it. ChatGPT gets only the job id and
 * the count, in the tool result's widget-only `_meta`. The private answer
 * panel collects the answer itself, directly from the relay:
 *
 * 1. Search time: the job's private analysis starts at once (a precompute),
 *    from the search-time Private evidence, while ChatGPT is still writing its
 *    own reply. The plaintext answer stays in this engine's memory only.
 *    ChatGPT often searches several times in one turn: a newer job from the
 *    same caller supersedes the older jobs' precomputes (they are cancelled),
 *    an identical question within PRIVATE_ANSWER_DEDUPE_MS shares one
 *    analysis, and a precompute that has not started within
 *    PRIVATE_ANSWER_PRECOMPUTE_WINDOW_MS of its search, unclaimed, is
 *    abandoned. Claimed work always runs before precomputes, the newest
 *    precompute first.
 * 2. The panel POSTs an ephemeral ECDH public key. The first key to arrive
 *    claims the job. Another key gets 409 `claimed`: the panel says the
 *    answer was already opened elsewhere, and this Mac writes a content-free
 *    audit line.
 * Eligibility (every model input): the live eligibility guard (`eligible`,
 *    the item's tier, the owner's rules and scope, and that it still exists,
 *    read when called) is asked immediately before every model submission:
 *    when an analysis is dispatched (dropping a no-longer-eligible item's
 *    cached text from the job then), and inside the private model before
 *    its document embeddings, its depth re-read and every answer-model call.
 *    An item it does not vouch for is never submitted. Nothing eligible left:
 *    no model call, and the analysis ends with no evidence.
 * 3. Claim time: the evidence is searched again (current tiers, not the
 *    search-time cache), and anything not Private-eligible now (Secret
 *    included) is dropped. The precomputed answer is used only when every
 *    item it read is still Private-eligible; otherwise it is discarded and the
 *    answer is computed again from the current evidence (or the job fails).
 *    The claiming POST holds briefly (PRIVATE_ANSWER_CLAIM_HOLD_MS) for the
 *    answer; until it is sealed, the claiming key gets 202 `pending` with
 *    Retry-After.
 *    Before an answer is sealed, and again after sealing and before it is
 *    released, every item it read must still pass the guard; otherwise it
 *    is discarded (a precompute is computed again once, a claim's own answer
 *    fails), so no answer derived from a now-ineligible item is ever shown.
 *    What the guard cannot do: recall text already handed to the on-device
 *    model when a tier change lands after that submission was issued.
 * 4. Then the claiming key gets 200 `ready` with the answer sealed to that
 *    key (private-answer-crypto.ts), padded to a size bucket so the
 *    ciphertext length does not reveal the answer length. The same key gets
 *    the same sealed bytes again until the job expires, so a replay of the
 *    panel's request (by anyone who saw it) is harmless and cannot consume
 *    the answer: only the holder of the panel's private key can open it.
 *
 * A hard deadline, counted from the claim, settles every claimed job as
 * ready or failed. Each analysis has its own deadline from its start, which
 * frees the analysis slot even when a model ignores its abort signal: the
 * analysis fails and the slot is freed first, then the model's `reset` (when
 * it has one) runs in the background, with its own timeout, to kill or reset
 * its runtime. Inference never starts for a claim after its deadline, even
 * when the evidence refresh finishes late. While an analysis runs, and from a
 * claim until it settles, the job counts as answer activity, so background
 * model work (the tier sniffer) yields to it, and each settled claim logs
 * one content-free line of stage timings.
 *
 * 5. Follow-up collection (design docs/design/frontier-consult-lane.md
 *    §A.5, stage C4a; AD-2 in private-answer-contract.ts). A job binds the
 *    outside-help policy current when it is created (`consultPolicy`); the
 *    claiming panel declares its capability (`cap`) in every request. When
 *    the policy has outside help on AND the panel declared capability 2, the
 *    first `ready` is the transition (first delivery, recorded by the engine)
 *    into a uniform phase: from then on every request by the claiming key
 *    gets `200 ready` with a freshly sealed envelope of exactly 36,864 padded
 *    plaintext bytes (private-answer-payload.ts), whatever an outside consult
 *    did. The job keeps its first-answer plaintext (bounded by the payload
 *    contract) and its source-open tokens, in memory only, for its lifetime;
 *    the outside block's state lives inside the envelope; a withdrawal (an
 *    item no longer eligible) is terminal and also lives inside the envelope.
 *    Such a job lives 30 minutes; its follow-up window is fixed at first
 *    delivery (20 minutes, capped by expiry) and a remount never extends it.
 *    The content is sealed; that outside help ran on a question may be
 *    inferred from timing, sizes and polling (accepted for version one).
 *    Every other job keeps the behavior above exactly: stored sealed bytes,
 *    bucket padding, plaintext `failed`.
 * 6. The consult handoff (design §A.2–A.3, stage C4b). The analysis keeps,
 *    beside its answer, the model's own verdict and the exact fitted pack its
 *    main call received (a reused precompute brings its search-time pack). At
 *    first delivery a follow-up job holds an immutable consult snapshot of
 *    that pack, the question, the answer and the gaps as retained, and the
 *    identities of the items read, for at most PRIVATE_ANSWER_CONSULT_SNAPSHOT_MS;
 *    `onFirstDelivered` hands the job id to the consult orchestrator
 *    (consult-orchestrator.ts), which reads the snapshot through
 *    `consultSnapshot`, drops it at its dispatch decision, and writes the
 *    outside block through the `outside*` seams. `onAnswerActivity` tells it
 *    a fresh answer is starting (any analysis or claim), so a writer in
 *    flight is killed. Nothing in the snapshot ever enters an envelope.
 *
 * Pending polls by the claiming key are rate limited per job (429), never
 * destructive. Unknown, expired (ten minutes from creation; thirty with
 * outside help on) and wrong-install jobs answer 410 `gone`: the endpoint is
 * no oracle for which ids existed.
 * Analyses run one at a time, and after a deadline the next one waits for
 * the model's reset (bounded). Claims of live jobs are rate limited; a claim
 * of an unknown id spends nothing. Nothing here is persisted: an engine
 * restart forgets every job and every answer; an expired job's answer is
 * dropped with it.
 */
import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import {
  PRIVATE_ANSWER_MAX_REQUEST_BYTES,
  isPanelOrigin,
  privateAnswerInstallId,
  privateAnswerRoute,
  type PrivateAnswerWireStatus,
} from '../../../connect-relay/shared/private-answer.ts';
import {
  PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS,
  PRIVATE_ANSWER_JOB_TTL_MS,
  PRIVATE_ANSWER_OUTSIDE_HELP_JOB_TTL_MS,
  PRIVATE_ANSWER_PANEL_CAPABILITY,
  PRIVATE_MATCH_COUNT_CAP,
  type PrivateAnswerCitation,
  type PrivateAnswerConsultSnapshotInput,
  type PrivateAnswerDetail,
  type PrivateAnswerEnvelopeV1,
  type PrivateAnswerModel,
  type PrivateAnswerModelCall,
  type PrivateAnswerOutsideBlockV1,
  type PrivateAnswerPanelCapability,
  type PrivateAnswerPlaintextV1,
  type PrivateEvidenceGuard,
  type PrivateEvidenceItem,
  type PrivateMatchSummary,
  NoPrivateEvidenceError,
  checkPrivateEvidence,
} from './private-answer-contract.ts';
import { importPanelPublicKey, padPrivateAnswerPlaintext, sealPrivateAnswer, type SealedPrivateAnswer } from './private-answer-crypto.ts';
import {
  PRIVATE_ANSWER_PAYLOAD_LIMITS,
  fitFirstAnswer,
  fitOutsideBlock,
  padPrivateAnswerEnvelope,
  preparePrivateAnswer,
  serializePrivateAnswerEnvelope,
  serializePrivateAnswerPlaintext,
} from './private-answer-payload.ts';
import { DEFAULT_CONSULT_SETTINGS, bindConsultJobPolicy, type ConsultJobPolicy } from '../../core/consult-settings.ts';

/** A content-free local audit event: no job id, no question, no key. */
export type PrivateAnswerAuditEvent = 'claimed_by_other_key' | 'analysis_deadline';

export interface PrivateAnswerJobsOptions {
  /** The private model (the private-model lane's `built_in` analyst), read per use. */
  model: () => PrivateAnswerModel;
  /**
   * Whether each evidence item may be read by a model right now, from live
   * state: asked when an analysis is dispatched and before (and after) an
   * answer is sealed. The model applies the same guard before each of its
   * own submissions. Anything it does not vouch for is never read.
   */
  eligible: PrivateEvidenceGuard;
  /** This engine's relay install id; no job is created without one. */
  installId: () => string | undefined;
  now?: () => number;
  ttlMs?: number;
  /** Live jobs at once; the oldest is dropped beyond this. */
  maxJobs?: number;
  /**
   * Pending polls per job (burst, refill per second). Over it a poll gets
   * 429 with Retry-After; the job is never dropped for polling, so a replay
   * of the claiming key cannot destroy a pending answer. Expiry alone ends it.
   */
  pollRate?: { capacity: number; refillPerSecond: number };
  /** Longest the background `reset()` of a model that passed its deadline may take before it is abandoned. */
  resetTimeoutMs?: number;
  /** Claims across all jobs: burst and refill per second. */
  claimRate?: { capacity: number; refillPerSecond: number };
  /**
   * Hard deadline for one claim (evidence refresh, any wait for the
   * analysis, and sealing), enforced outside the model; also the bound on
   * one analysis's run, from its start.
   */
  analysisTimeoutMs?: number;
  /** The same bound for a `detail: "full"` job (default PRIVATE_ANSWER_FULL_ANALYSIS_TIMEOUT_MS). */
  fullAnalysisTimeoutMs?: number;
  /** Start each job's analysis when the job is created (default true). */
  precompute?: boolean;
  /**
   * The claiming POST waits up to this long for the answer before it
   * answers 202 (default PRIVATE_ANSWER_CLAIM_HOLD_MS), so a precomputed
   * answer reaches the panel in its first response, not after a poll interval.
   */
  claimHoldMs?: number;
  /** An identical question within this long shares one analysis. */
  dedupeMs?: number;
  /** An unclaimed job's precompute that has not started this long after its search is abandoned. */
  precomputeWindowMs?: number;
  /** Local audit log (default: one line on stderr). */
  audit?: (event: PrivateAnswerAuditEvent) => void;
  /**
   * Answer activity: `begin` when an analysis starts or a job is claimed,
   * `end` once it finishes or the claim settles (exactly once each). The
   * worker pauses the tier sniffer and other background model work in
   * between, so the answer never waits on it. A `begin` that returns a
   * release is ended through it, so one job never ends another's lease.
   */
  activity?: { begin(): (() => void) | void; end(): void };
  /** The per-claim stage timing line (default: stdout). Counts and milliseconds only. */
  log?: (line: string) => void;
  /**
   * Opens a source's local file on this computer (macOS `open`). Without
   * it, sources carry no open token. Called only with a path this engine
   * resolved for an item the answer cites, never one from a request.
   */
  openFile?: (path: string) => Promise<void>;
  /** Open requests per job (burst, refill per second). */
  openRate?: { capacity: number; refillPerSecond: number };
  /** Open requests across all jobs (burst, refill per second). */
  openRateGlobal?: { capacity: number; refillPerSecond: number };
  /**
   * The outside-help policy a job binds when it is created (design "Job
   * policy"): read at every `begin`, never cached here. Production passes
   * `() => bindConsultJobPolicy(readConsultSettings())`; without it every job
   * binds outside help off, so nothing here ever enters follow-up collection.
   */
  consultPolicy?: () => ConsultJobPolicy;
  /** A job with outside help on lives this long (default PRIVATE_ANSWER_OUTSIDE_HELP_JOB_TTL_MS). */
  outsideHelpTtlMs?: number;
  /** The follow-up window from first delivery (default PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS), capped by the job's expiry. */
  followUpWindowMs?: number;
  /**
   * First delivery of a follow-up job (the first `ready` actually returned to
   * the claiming key): the consult orchestrator's trigger. Called once per
   * job, synchronously, after the clocks are published. A throw never fails
   * the response.
   */
  onFirstDelivered?: (jobId: string) => void;
  /**
   * A fresh private answer is starting (an analysis runs, or a job is
   * claimed): the signal that kills a consult writer in flight (design §A.7).
   * Called beside `activity.begin`.
   */
  onAnswerActivity?: () => void;
  /** How long a consult snapshot is kept after first delivery (default PRIVATE_ANSWER_CONSULT_SNAPSHOT_MS). */
  consultSnapshotMs?: number;
}

/** One claim's stage costs, logged once it settles. No id, question, evidence or answer. */
interface AnalysisTiming {
  outcome: 'sealed' | 'failed';
  reason: 'deadline' | 'aborted' | 'no_evidence' | 'error';
  /** The answer came from the search-time analysis (`yes`), or was computed for the claim (`no`). */
  precomputed?: boolean;
  /** From the claim until the answer was there to seal (refresh, and any wait for the analysis). */
  waitAtClaimMs?: number;
  /** From the search until the answer was ready. */
  searchToReadyMs?: number;
  /** The analysis's wait for the model slot. */
  queuedMs: number;
  refreshMs?: number;
  /** The dispatch-time eligibility check of the analysis's cached evidence. */
  recheckMs?: number | undefined;
  /** Cached evidence items the dispatch-time eligibility check dropped. */
  dropped?: number | undefined;
  matched?: number;
  items?: number | undefined;
  unreadable?: number | undefined;
  evidenceBytes?: number | undefined;
  modelMs?: number | undefined;
  calls: PrivateAnswerModelCall[];
  totalMs?: number;
}

class AnalysisStop extends Error {
  constructor(readonly reason: 'aborted' | 'no_evidence') {
    super(reason);
  }
}

const defaultLog = (line: string) => {
  console.log(line);
};

/** `[private-answer] outcome=… precomputed=… wait_at_claim_ms=… …`: stage costs only. */
export function formatAnalysisTiming(timing: AnalysisTiming): string {
  const fields: string[] = [`outcome=${timing.outcome}`];
  if (timing.outcome === 'failed') fields.push(`reason=${timing.reason}`);
  if (timing.precomputed !== undefined) fields.push(`precomputed=${timing.precomputed ? 'yes' : 'no'}`);
  if (timing.waitAtClaimMs !== undefined) fields.push(`wait_at_claim_ms=${timing.waitAtClaimMs}`);
  if (timing.searchToReadyMs !== undefined) fields.push(`search_to_ready_ms=${timing.searchToReadyMs}`);
  fields.push(`queued_ms=${timing.queuedMs}`);
  if (timing.refreshMs !== undefined) fields.push(`refresh_ms=${timing.refreshMs}`);
  if (timing.recheckMs !== undefined) fields.push(`recheck_ms=${timing.recheckMs}`);
  if (timing.dropped) fields.push(`dropped=${timing.dropped}`);
  if (timing.matched !== undefined) fields.push(`matched=${timing.matched}`);
  if (timing.items !== undefined) fields.push(`items=${timing.items}`);
  if (timing.unreadable !== undefined) fields.push(`unreadable=${timing.unreadable}`);
  if (timing.evidenceBytes !== undefined) fields.push(`evidence_bytes=${timing.evidenceBytes}`);
  if (timing.modelMs !== undefined) fields.push(`model_ms=${timing.modelMs}`);
  for (const call of timing.calls) {
    const prefix = call.stage;
    fields.push(`${prefix}_ms=${call.ms}`, `${prefix}_prompt_bytes=${call.promptBytes}`);
    if (!call.ok) fields.push(`${prefix}_ok=false`);
    if (call.promptTokens !== undefined) fields.push(`${prefix}_prompt_tokens=${call.promptTokens}`);
    if (call.promptMs !== undefined) fields.push(`${prefix}_prefill_ms=${call.promptMs}`);
    if (call.outputTokens !== undefined) fields.push(`${prefix}_output_tokens=${call.outputTokens}`);
    if (call.outputMs !== undefined) fields.push(`${prefix}_generate_ms=${call.outputMs}`);
  }
  if (timing.totalMs !== undefined) fields.push(`total_ms=${timing.totalMs}`);
  return `[private-answer] ${fields.join(' ')}`;
}

/** Re-reads the job's evidence at claim time, at the items' current tiers. */
export type PrivateEvidenceRefresh = (signal: AbortSignal) => Promise<readonly PrivateEvidenceItem[]>;

/**
 * One run of the private model over one question's eligible evidence: a
 * search-time precompute, or a claim's own computation. Shared by every job
 * that asked the identical question within the dedupe window. Its plaintext
 * answer lives only here, in memory, until no job holds it.
 */
interface Analysis {
  readonly key: string;
  readonly detail: PrivateAnswerDetail;
  readonly createdAt: number;
  /** Set when a claim waits on it: claimed work runs first, oldest claim first. */
  claimedAt: number | undefined;
  question: string | undefined;
  evidence: readonly PrivateEvidenceItem[] | undefined;
  state: 'queued' | 'running' | 'done' | 'failed';
  result: {
    plaintext: PrivateAnswerPlaintextV1;
    localPaths: readonly (string | undefined)[];
    usedKeys: readonly string[] | undefined;
    /** The evidence items the answer read, checked against the live guard before it is sealed. */
    usedItems: readonly PrivateEvidenceItem[];
    /**
     * The model's verdict and the fitted pack it read (C4b), exactly as the
     * model returned them (no clone, no freeze: a job without outside help
     * sharing this analysis is unaffected); undefined from a model that
     * supplies none. The consulting job's own continuation validates, clones
     * and freezes it into its snapshot.
     */
    consult: unknown;
  } | undefined;
  failReason: AnalysisTiming['reason'] | undefined;
  startedAt: number | undefined;
  readyAt: number | undefined;
  stats: Pick<AnalysisTiming, 'items' | 'unreadable' | 'evidenceBytes' | 'modelMs' | 'recheckMs' | 'dropped'> & { calls: PrivateAnswerModelCall[] };
  readonly abort: AbortController;
  readonly jobs: Set<Job>;
  readonly settled: Promise<void>;
  settle: () => void;
}

/** The first answer a follow-up job keeps, bounded by the payload contract, with its open tokens already in place. */
interface RetainedAnswer {
  readonly answer: string;
  readonly citations: readonly PrivateAnswerCitation[];
  readonly unanswered: readonly string[] | undefined;
}

interface Job {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly caller: string | undefined;
  readonly detail: PrivateAnswerDetail;
  /** The outside-help policy bound at creation; later setting changes never alter it. */
  readonly policy: ConsultJobPolicy;
  question: string | undefined;
  evidence: readonly PrivateEvidenceItem[] | undefined;
  refresh: PrivateEvidenceRefresh | undefined;
  analysis: Analysis | undefined;
  claimKey?: string;
  /** The capability the claiming panel declared in its first request (1 when it sent none). */
  panelCapability?: PrivateAnswerPanelCapability;
  /** Decided at the claim: outside help on in the policy and capability 2 declared. */
  followUp: boolean;
  pollTokens: number;
  pollRefilledAt: number;
  /**
   * `sealed`: today's stored bytes, handed out again. `retained`: a follow-up
   * job's first answer, sealed afresh on every request. `withdrawn`: a
   * follow-up job whose answer was withdrawn, terminal, told inside the
   * envelope. `failed`: before first delivery, or any other job, in plaintext.
   */
  outcome?:
    | { kind: 'sealed'; sealed: SealedPrivateAnswer }
    | { kind: 'retained'; answer: RetainedAnswer }
    | { kind: 'withdrawn' }
    | { kind: 'failed' }
    | undefined;
  /** Follow-up state: the revision only increases; the outside block lives here until it is sealed. */
  rev: number;
  outside: PrivateAnswerOutsideBlockV1;
  /** Server-owned clocks (design §A.5.6): published only with the first `ready` actually returned to the claiming key. */
  firstDeliveredAt?: number;
  followUntil?: number;
  /** The last collection by the claiming key (the recent-activity input of final authorization, C4b). */
  lastCollectedAt?: number;
  /**
   * The consult handoff (C4b): the immutable snapshot the gate compares
   * against, kept from first delivery for at most consultSnapshotMs; the
   * send-once latch; and whether the consult for this job is over (sent,
   * refused, skipped or failed), so it is never triggered twice.
   */
  consult: {
    snapshot: PrivateAnswerConsultSnapshot | undefined;
    snapshotExpiresAt: number | undefined;
    latch: boolean;
    settled: boolean;
  };
  /**
   * The evidence items the sealed answer read, identities only (no text):
   * every later hand-out of the sealed bytes, and every source open, asks
   * the live guard about them first.
   */
  sealedItems?: readonly PrivateEvidenceItem[] | undefined;
  claimAbort?: AbortController;
  /**
   * This job's source-open capabilities: token → local file, minted when
   * its answer is sealed (the tokens ride inside the sealed plaintext only)
   * and dropped with the job.
   */
  opens?: Map<string, string> | undefined;
  openTokens: number;
  openRefilledAt: number;
}

export interface ClaimResponse {
  status: number;
  body: { status: PrivateAnswerWireStatus } & Record<string, unknown>;
  retryAfterSeconds?: number;
}

const MAX_QUESTION_CHARS = 4_000;
/** Seals one phase-2 response may make over a state that keeps changing before the job is withdrawn instead. */
const FOLLOW_UP_SEAL_ATTEMPTS = 8;
/** A source-open token: 32 random bytes, base64url. */
const OPEN_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${PRIVATE_ANSWER_PAYLOAD_LIMITS.openTokenChars}}$`);
const MAX_EVIDENCE_ITEMS = 50;
const PENDING_RETRY_SECONDS = 2;
/**
 * Inside the panel's own two-minute wait (CHATGPT_PRIVATE_ANSWER_POLL_CAP_MS),
 * so the panel always sees `ready` or `failed`, never gives up on a job the
 * engine is still running.
 */
export const PRIVATE_ANSWER_ANALYSIS_TIMEOUT_MS = 100_000;
/**
 * A `detail: "full"` job reads its leading items whole and writes a longer
 * answer, which a busy Mac can take well past the summary bound to finish
 * (2026-10-02: 179.4 s of a 180 s bound, prefill 64 s and 2.8 tokens/s on a
 * loaded Mac). The job's `_meta` says `detail: "full"`, so the panel waits
 * a little longer than this (CHATGPT_PRIVATE_ANSWER_FULL_POLL_CAP_MS).
 */
export const PRIVATE_ANSWER_FULL_ANALYSIS_TIMEOUT_MS = 240_000;
/** An identical question asked again within this long reuses the answer. */
export const PRIVATE_ANSWER_DEDUPE_MS = 3 * 60_000;
/** An unclaimed job's precompute not started within this long of its search is abandoned. */
export const PRIVATE_ANSWER_PRECOMPUTE_WINDOW_MS = 2 * 60_000;
/** How long the claiming POST holds for a ready answer (refresh and seal) before it answers 202. */
export const PRIVATE_ANSWER_CLAIM_HOLD_MS = 1_500;
/** A consult snapshot lives this long after first delivery (design §A.3: until the dispatch decision, at most 5 minutes). */
export const PRIVATE_ANSWER_CONSULT_SNAPSHOT_MS = 5 * 60_000;
/** A job that binds no reader binds this: outside help off, so no follow-up collection. */
const OUTSIDE_HELP_OFF: ConsultJobPolicy = bindConsultJobPolicy({ state: 'absent', settings: DEFAULT_CONSULT_SETTINGS });

const defaultAudit = (event: PrivateAnswerAuditEvent) => {
  console.warn(`[olympus] private answer audit: ${event === 'claimed_by_other_key'
    ? 'a second key tried to open a private answer that was already claimed'
    : 'a private analysis hit its deadline and was stopped'}`);
};

/**
 * Whether a search hit may feed a private answer: Private (secure_local) only.
 * A hit that names any other trust domain, or any Secret tier, is dropped.
 * A hit naming neither came from a Private corpus search and is kept.
 */
export function isPrivateEligible(item: PrivateEvidenceItem): boolean {
  const domain = item.trust_domain ?? item.trustDomain;
  if (domain !== undefined && domain !== 'secure_local') return false;
  for (const key of ['trust_tier', 'trustTier', 'tier', 'content_tier', 'contentTier', 'metadata_tier', 'metadataTier']) {
    const tier = item[key];
    // Secret by name, or by trust tier: S5 is Secrets.
    if (typeof tier === 'string' && (/secret/i.test(tier) || tier.trim().toUpperCase() === 'S5')) return false;
  }
  return true;
}

/**
 * A stable identity for one evidence item (its source item: provider,
 * account, item id; for a hit without one, the whole hit), or undefined when
 * it has none. The claim-time check matches the items an answer read against
 * the current evidence by it.
 */
export function privateEvidenceKey(item: PrivateEvidenceItem): string | undefined {
  const provenance = asRecord(item.provenance);
  const source = asRecord(item.sourceItem) ?? asRecord(provenance?.sourceItem);
  const id = text(source?.localItemId) ?? text(source?.providerItemId);
  if (source && id) {
    return JSON.stringify(['item', text(source.provider) ?? '', text(source.family) ?? '', text(source.accountScope) ?? '', id]);
  }
  // No source identity: only the identical hit (same fields, same tiers) matches.
  try {
    return JSON.stringify(['hit', item]);
  } catch {
    return undefined;
  }
}

/** The dedupe key: the question, case and spacing aside. */
function questionKey(question: string): string {
  return question.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export class PrivateAnswerJobs {
  // Assigned in the constructor, not as field initializers: an initializer
  // would make the bundler keep this module in bundles that never use it.
  private readonly jobs: Map<string, Job>;
  /** Analyses an identical question may share, by question key, within the dedupe window. */
  private readonly shared: Map<string, Analysis>;
  /** Analyses waiting for the model slot. */
  private readonly waiting: Analysis[];
  private running: Analysis | undefined;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxJobs: number;
  private readonly pollRate: { capacity: number; refillPerSecond: number };
  private readonly resetTimeoutMs: number;
  private readonly claimRate: { capacity: number; refillPerSecond: number };
  private readonly analysisTimeoutMs: number;
  private readonly fullAnalysisTimeoutMs: number;
  private readonly dedupeMs: number;
  private readonly precomputeWindowMs: number;
  private readonly audit: (event: PrivateAnswerAuditEvent) => void;
  private tokens: number;
  private refilledAt: number;
  private openTokens: number;
  private openRefilledAt: number;
  private readonly openRate: { capacity: number; refillPerSecond: number };
  private readonly openRateGlobal: { capacity: number; refillPerSecond: number };
  private readonly outsideHelpTtlMs: number;
  private readonly followUpWindowMs: number;
  private readonly consultSnapshotMs: number;
  /** A deadline's background reset, bounded by resetTimeoutMs; the next analysis waits for it. */
  private resetting: Promise<void> | undefined;
  private readonly options: PrivateAnswerJobsOptions;

  constructor(options: PrivateAnswerJobsOptions) {
    this.options = options;
    this.jobs = new Map();
    this.shared = new Map();
    this.waiting = [];
    this.running = undefined;
    this.resetting = undefined;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PRIVATE_ANSWER_JOB_TTL_MS;
    this.maxJobs = options.maxJobs ?? 200;
    this.pollRate = options.pollRate ?? { capacity: 10, refillPerSecond: 1 };
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.claimRate = options.claimRate ?? { capacity: 60, refillPerSecond: 10 };
    this.analysisTimeoutMs = options.analysisTimeoutMs ?? PRIVATE_ANSWER_ANALYSIS_TIMEOUT_MS;
    this.fullAnalysisTimeoutMs = options.fullAnalysisTimeoutMs ?? PRIVATE_ANSWER_FULL_ANALYSIS_TIMEOUT_MS;
    this.dedupeMs = options.dedupeMs ?? PRIVATE_ANSWER_DEDUPE_MS;
    this.precomputeWindowMs = options.precomputeWindowMs ?? PRIVATE_ANSWER_PRECOMPUTE_WINDOW_MS;
    this.audit = options.audit ?? defaultAudit;
    this.tokens = this.claimRate.capacity;
    this.refilledAt = this.now();
    this.openRate = options.openRate ?? { capacity: 4, refillPerSecond: 0.2 };
    this.openRateGlobal = options.openRateGlobal ?? { capacity: 10, refillPerSecond: 0.2 };
    this.openTokens = this.openRateGlobal.capacity;
    this.openRefilledAt = this.now();
    this.outsideHelpTtlMs = options.outsideHelpTtlMs ?? PRIVATE_ANSWER_OUTSIDE_HELP_JOB_TTL_MS;
    this.followUpWindowMs = options.followUpWindowMs ?? PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS;
    this.consultSnapshotMs = options.consultSnapshotMs ?? PRIVATE_ANSWER_CONSULT_SNAPSHOT_MS;
  }

  get size(): number {
    return this.jobs.size;
  }

  /** Analyses queued or running (precomputes and claims). */
  get pendingAnalyses(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  /**
   * A private match: the panel summary, with a job when a private model is
   * ready and this engine has a relay install id. Counts and state only
   * otherwise. `count` is capped at PRIVATE_MATCH_COUNT_CAP. Call it as the
   * tool result is built, so the id is valid only from then on. The job's
   * analysis starts now, from `evidence` (Private-eligible items only).
   * `refresh` is the same Private search again, at claim time: it proposes
   * the current evidence (the live guard decides what may be read). `caller` (the
   * connection) lets a newer job supersede that caller's older precomputes.
   */
  begin(input: {
    question: string;
    count: number;
    evidence: readonly PrivateEvidenceItem[];
    refresh: PrivateEvidenceRefresh;
    caller?: string;
    /** `full` reads the leading items in depth (slower); `summary` by default. */
    detail?: PrivateAnswerDetail;
  }): PrivateMatchSummary & { jobId?: string } {
    const count = Math.max(0, Math.min(PRIVATE_MATCH_COUNT_CAP, Math.floor(input.count)));
    const status = this.options.model().status();
    if (status.state === 'model_downloading') {
      return {
        count,
        panelState: 'model_downloading',
        ...(typeof status.percent === 'number' && Number.isFinite(status.percent)
          ? { percent: Math.max(0, Math.min(100, Math.round(status.percent))) }
          : {}),
      };
    }
    if (status.state !== 'ready') return { count, panelState: 'no_model' };
    const installId = this.options.installId();
    if (!installId || count === 0 || input.evidence.length === 0) return { count, panelState: 'no_model' };
    this.sweep();
    while (this.jobs.size >= this.maxJobs) {
      const oldest = this.jobs.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    const id = `oly2p.${installId}.${randomBytes(32).toString('base64url')}`;
    const at = this.now();
    // The policy is bound now, once, for the job's whole life: its lifetime
    // follows it, and a later change to the settings never alters it.
    const policy = this.bindPolicy();
    const job: Job = {
      id,
      createdAt: at,
      expiresAt: at + (policy.outsideHelp ? this.outsideHelpTtlMs : this.ttlMs),
      caller: input.caller,
      detail: input.detail === 'full' ? 'full' : 'summary',
      policy,
      question: input.question.slice(0, MAX_QUESTION_CHARS),
      evidence: input.evidence.slice(0, MAX_EVIDENCE_ITEMS),
      refresh: input.refresh,
      analysis: undefined,
      followUp: false,
      pollTokens: this.pollRate.capacity,
      pollRefilledAt: at,
      rev: 0,
      outside: { state: 'idle' },
      consult: { snapshot: undefined, snapshotExpiresAt: undefined, latch: false, settled: false },
      openTokens: this.openRate.capacity,
      openRefilledAt: at,
    };
    this.jobs.set(id, job);
    if (this.options.precompute !== false) this.precompute(job);
    return { count, panelState: 'ready', jobId: id, ...(job.detail === 'full' ? { detail: 'full' as const } : {}) };
  }

  /**
   * One panel POST: claim, poll, or collect (idempotent for the claiming key
   * until expiry). `capability` is what the request body declared (`cap`);
   * it is recorded at the claim and ignored afterwards.
   */
  async claim(jobId: string, publicKey: unknown, capability: PrivateAnswerPanelCapability = 1): Promise<ClaimResponse> {
    this.sweep();
    const job = this.jobs.get(jobId);
    // Wrong install, unknown or expired: one answer for all, and no claim
    // token spent, so a flood of made-up ids cannot lock out a real panel.
    if (!job || privateAnswerInstallId(jobId) !== this.options.installId()) return gone();
    if (!this.takeToken()) return { status: 429, body: { status: 'rate_limited' }, retryAfterSeconds: 5 };
    const panel = await importPanelPublicKey(publicKey);
    if (!panel) return { status: 400, body: { status: 'invalid' } };
    // The job may have gone while the key was imported.
    if (this.jobs.get(jobId) !== job) return gone();
    if (job.claimKey !== undefined && job.claimKey !== panel.raw) {
      this.audit('claimed_by_other_key');
      return { status: 409, body: { status: 'claimed' } };
    }
    if (job.claimKey === undefined) {
      job.claimKey = panel.raw;
      job.panelCapability = capability === PRIVATE_ANSWER_PANEL_CAPABILITY ? PRIVATE_ANSWER_PANEL_CAPABILITY : 1;
      // Follow-up collection needs both: the policy bound at creation and
      // the panel's declared capability. Neither depends on any consult.
      job.followUp = job.policy.outsideHelp && job.panelCapability === PRIVATE_ANSWER_PANEL_CAPABILITY;
      const settled = this.startClaim(job, panel.key);
      // A precomputed answer needs only the evidence re-read and the seal:
      // wait briefly so the panel gets it in this response.
      const holdMs = this.options.claimHoldMs ?? PRIVATE_ANSWER_CLAIM_HOLD_MS;
      if (holdMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([settled, new Promise<void>((resolve) => {
          timer = setTimeout(resolve, holdMs);
          (timer as { unref?: () => void }).unref?.();
        })]);
        clearTimeout(timer);
      }
      if (this.jobs.get(jobId) !== job) return gone();
    }
    const outcome = job.outcome;
    if (!outcome) {
      if (!this.takePoll(job)) return { status: 429, body: { status: 'rate_limited' }, retryAfterSeconds: PENDING_RETRY_SECONDS };
      return { status: 202, body: { status: 'pending' }, retryAfterSeconds: PENDING_RETRY_SECONDS };
    }
    if (outcome.kind === 'failed') return { status: 200, body: { status: 'failed' } };
    // Phase 2: from first delivery, one response shape for every state.
    if (outcome.kind === 'retained' || outcome.kind === 'withdrawn') return this.followUpResponse(job, panel.key);
    // Every hand-out of the sealed bytes, not only the first: an item the
    // answer read that is no longer eligible withdraws it for good.
    if (!(await this.stillReleasable(job))) return this.jobs.get(jobId) === job ? { status: 200, body: { status: 'failed' } } : gone();
    if (this.jobs.get(jobId) !== job || job.outcome !== outcome) return job.outcome?.kind === 'failed' ? { status: 200, body: { status: 'failed' } } : gone();
    return { status: 200, body: { status: 'ready', v: 1, ...outcome.sealed } };
  }

  /* -------------------------------------------------------------- */
  /* Follow-up collection (phase 2)                                   */
  /* -------------------------------------------------------------- */

  /**
   * The phase-2 response: a freshly sealed, exactly-sized envelope carrying
   * the job's current state (design §A.5.3 race rules).
   *
   * 1. Read the revision and the state.
   * 2. Run the eligibility guard (a withdrawal is terminal, in-envelope).
   * 3. Seal.
   * 4. Run the guard again and re-read the revision, the state and the
   *    deadline. A ciphertext sealed over a state that has since changed is
   *    never handed out: the loop seals again over the current state. A
   *    withdrawal always wins, and is stable, so the loop ends; a state that
   *    keeps moving past the retry budget withdraws the job (fail closed)
   *    and returns that.
   * 5. Only then are the delivery clocks published: first delivery is the
   *    first `ready` actually returned, never a seal that failed.
   */
  private async followUpResponse(job: Job, panelKey: CryptoKey): Promise<ClaimResponse> {
    const at = this.now();
    for (let attempt = 0; ; attempt += 1) {
      await this.guardFollowUp(job);
      if (this.jobs.get(job.id) !== job) return gone();
      if (attempt >= FOLLOW_UP_SEAL_ATTEMPTS) this.withdraw(job);
      const rev = job.rev;
      const kind = job.outcome?.kind;
      // The window the envelope reports: the committed one, or this request's
      // proposal when none is committed yet. Overlapping first collections
      // each propose their own; the first successful seal commits, and a
      // later one sealed over a different proposal is sealed again over the
      // committed window, so every envelope reports the same deadline.
      const followUntil = job.followUntil ?? Math.min(at + this.followUpWindowMs, job.expiresAt);
      const plaintext = this.envelopeFor(job, followUntil);
      if (plaintext === undefined) return gone();
      const sealed = await sealPrivateAnswer(job.id, panelKey, plaintext);
      // The final release checks, after the seal and immediately before the hand-out.
      await this.guardFollowUp(job);
      if (this.jobs.get(job.id) !== job) return gone();
      if (job.rev !== rev || job.outcome?.kind !== kind) continue;
      if (job.followUntil !== undefined && job.followUntil !== followUntil) continue;
      const first = job.firstDeliveredAt === undefined;
      if (first) {
        // First delivery: the transition into phase 2, and the one moment the
        // follow-up window is fixed. A remount later never moves it.
        job.firstDeliveredAt = at;
        job.followUntil = followUntil;
        // The consult snapshot's clock starts here (design §A.3 retention).
        if (job.consult.snapshot) job.consult.snapshotExpiresAt = at + this.consultSnapshotMs;
      }
      // The most recent collection by the claiming key; never earlier than one already recorded.
      job.lastCollectedAt = Math.max(job.lastCollectedAt ?? 0, at);
      if (first) {
        try {
          this.options.onFirstDelivered?.(job.id);
        } catch {
          // The orchestrator never fails a response.
        }
      }
      return { status: 200, body: { status: 'ready', v: 1, ...sealed } };
    }
  }

  /**
   * The live guard over the items a retained answer read, on every phase-2
   * hand-out: an item refused now withdraws the answer (terminal).
   */
  private async guardFollowUp(job: Job): Promise<void> {
    if (job.outcome?.kind !== 'retained') return;
    const items = job.sealedItems;
    const ok = await checkPrivateEvidence(this.options.eligible, items ?? []);
    if ((job.outcome as Job['outcome'])?.kind !== 'retained') return;
    if (items !== undefined && ok.every(Boolean)) return;
    this.withdraw(job);
  }

  /**
   * The padded envelope plaintext for the job's current state, or undefined
   * when the job is gone. A plaintext the padder rejects is a bug upstream
   * and fails closed: the outside block is dropped; if it still does not
   * fit, the answer is withdrawn.
   */
  private envelopeFor(job: Job, followUntil: number): string | undefined {
    const outcome = job.outcome;
    if (!outcome || (outcome.kind !== 'retained' && outcome.kind !== 'withdrawn')) return undefined;
    const followSeconds = Math.max(0, Math.ceil((followUntil - this.now()) / 1000));
    const envelope = (): PrivateAnswerEnvelopeV1 => (job.outcome?.kind === 'retained'
      ? { v: 1, rev: job.rev, state: 'answer', answer: job.outcome.answer.answer, citations: [...job.outcome.answer.citations], ...(job.outcome.answer.unanswered ? { unanswered: [...job.outcome.answer.unanswered] } : {}), followSeconds, outside: { ...job.outside } }
      : { v: 1, rev: job.rev, state: 'withdrawn', followSeconds, outside: { state: 'idle' } });
    try {
      return padPrivateAnswerEnvelope(serializePrivateAnswerEnvelope(envelope()));
    } catch {
      if (job.outcome?.kind === 'retained' && job.outside.state !== 'idle') {
        job.outside = { state: 'idle' };
        job.rev += 1;
        try {
          return padPrivateAnswerEnvelope(serializePrivateAnswerEnvelope(envelope()));
        } catch {
          // Falls through to the withdrawal.
        }
      }
      this.withdraw(job);
      return padPrivateAnswerEnvelope(serializePrivateAnswerEnvelope(envelope()));
    }
  }

  /** Terminal: the answer, the outside block, the question, the items, the tokens and the consult snapshot are gone; the revision moves once more. */
  private withdraw(job: Job): void {
    if (job.outcome?.kind === 'withdrawn') return;
    job.outcome = { kind: 'withdrawn' };
    job.outside = { state: 'idle' };
    job.question = undefined;
    job.sealedItems = undefined;
    job.opens = undefined;
    this.forgetConsultSnapshot(job);
    job.consult.settled = true;
    job.rev += 1;
  }

  /* -------------------------------------------------------------- */
  /* The consult handoff (C4b)                                        */
  /* -------------------------------------------------------------- */

  /**
   * The job's consult snapshot (design §A.3): the fitted pack the first
   * answer's model call read, the question, the answer and the gaps as
   * retained, the verdict and the identities of the items read. Frozen, and
   * the same object on every read. Undefined for a job that is unknown, not
   * in follow-up collection, not yet delivered, withdrawn, past the snapshot's
   * retention, or whose consult is over.
   */
  consultSnapshot(jobId: string): PrivateAnswerConsultSnapshot | undefined {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (!job || !job.followUp || job.outcome?.kind !== 'retained' || job.firstDeliveredAt === undefined) return undefined;
    if (job.consult.settled) return undefined;
    this.expireConsultSnapshot(job, this.now());
    return job.consult.snapshot;
  }

  /** Drops the job's consult snapshot now (the orchestrator's dispatch decision, or its refusal). */
  dropConsultSnapshot(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) this.forgetConsultSnapshot(job);
  }

  /**
   * The send-once latch (design §A.5.6), set inside final authorization:
   * true exactly once per job, for a delivered follow-up job in state
   * `answer` whose block is `pending` and whose follow-up window is open.
   * Synchronous, so two authorizations cannot both take it.
   */
  takeConsultLatch(jobId: string): boolean {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (!job || !job.followUp || job.outcome?.kind !== 'retained' || job.firstDeliveredAt === undefined || job.followUntil === undefined) return false;
    if (job.consult.latch || job.consult.settled || job.outside.state !== 'pending') return false;
    if (this.now() > job.followUntil) return false;
    job.consult.latch = true;
    return true;
  }

  private forgetConsultSnapshot(job: Job): void {
    job.consult.snapshot = undefined;
    job.consult.snapshotExpiresAt = undefined;
  }

  private expireConsultSnapshot(job: Job, at: number): void {
    if (job.consult.snapshotExpiresAt !== undefined && at >= job.consult.snapshotExpiresAt) this.forgetConsultSnapshot(job);
  }

  /**
   * What stage C4b reads before it writes a consult: the follow-up state of
   * one job, or undefined when the job is unknown, expired, or not in
   * follow-up collection. Clocks are the server's. No answer text.
   */
  outsideSeam(jobId: string): PrivateAnswerFollowUpState | undefined {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (!job || !job.followUp || job.panelCapability === undefined) return undefined;
    const state = job.outcome?.kind === 'retained' ? 'answer' : job.outcome?.kind === 'withdrawn' ? 'withdrawn' : 'pending';
    return {
      rev: job.rev,
      state,
      outside: job.outside.state,
      policy: job.policy,
      panelCapability: job.panelCapability,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      firstDeliveredAt: job.firstDeliveredAt,
      followUntil: job.followUntil,
      lastCollectedAt: job.lastCollectedAt,
    };
  }

  /**
   * Moves the outside block to `pending` or `paused`, or back to `idle`, by a
   * compare-and-set on the revision (C4b seam). Only a delivered follow-up
   * job in state `answer`, inside its follow-up window, whose block is not
   * yet appended accepts it. `failed` ends the job's consult for good (the
   * block reads `idle`, the snapshot is dropped, and nothing triggers it
   * again): the panel shows nothing more. `pending` is the schedule mark; it
   * is refused once the consult is over.
   */
  markOutside(jobId: string, expectedRev: number, state: 'idle' | 'pending' | 'paused' | 'failed'): OutsideSeamResult {
    if (state === 'failed') {
      // Ending a consult is allowed after the window too, so a block never
      // stays `pending` once its consult is over; the revision rule holds.
      this.sweep();
      const job = this.jobs.get(jobId);
      if (!job || !job.followUp) return { ok: false, reason: 'unknown' };
      if (job.outcome?.kind === 'withdrawn') return { ok: false, reason: 'withdrawn' };
      if (job.outside.state === 'appended') return { ok: false, reason: 'already_appended' };
      if (job.rev !== expectedRev) return { ok: false, reason: 'stale_rev' };
      job.consult.settled = true;
      this.forgetConsultSnapshot(job);
      if (job.outside.state === 'idle') return { ok: true, rev: job.rev };
      job.outside = { state: 'idle' };
      job.rev += 1;
      return { ok: true, rev: job.rev };
    }
    const check = this.outsideWritable(jobId, expectedRev);
    if (!check.ok) return check;
    const job = check.job;
    if (state === 'pending' && job.consult.settled) return { ok: false, reason: 'already_appended' };
    // Idempotent: writing the state the block already has moves nothing, so
    // a writer repeating itself cannot drive the re-seal loop.
    if (job.outside.state === state) return { ok: true, rev: job.rev };
    job.outside = { state };
    job.rev += 1;
    return { ok: true, rev: job.rev };
  }

  /**
   * Appends the outside reply to a delivered follow-up job (C4b seam): a
   * synchronous compare-and-set on the revision, only while the job is in
   * state `answer`, at most once per job, never after the follow-up window.
   * The block is normalized and budgeted by the payload contract before it
   * is retained (only the fitted fields and `cut` are kept), so what a job
   * holds is bounded whatever the reply was. A reply for a withdrawn,
   * expired or evicted job is discarded: nothing restores a withdrawn job.
   */
  appendOutsideBlock(jobId: string, expectedRev: number, block: { text: string; question?: string; route?: string }): OutsideSeamResult {
    const check = this.outsideWritable(jobId, expectedRev);
    if (!check.ok) return check;
    const job = check.job;
    job.outside = fitOutsideBlock({
      state: 'appended',
      text: typeof block.text === 'string' ? block.text : '',
      ...(typeof block.question === 'string' ? { question: block.question } : {}),
      ...(typeof block.route === 'string' ? { route: block.route } : {}),
    });
    job.consult.settled = true;
    this.forgetConsultSnapshot(job);
    job.rev += 1;
    return { ok: true, rev: job.rev };
  }

  /** The shared condition of both outside seams, the follow-up window included. */
  private outsideWritable(jobId: string, expectedRev: number): { ok: true; job: Job } | (OutsideSeamResult & { ok: false }) {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (!job || !job.followUp) return { ok: false, reason: 'unknown' };
    if (job.outcome?.kind === 'withdrawn') return { ok: false, reason: 'withdrawn' };
    if (job.outcome?.kind !== 'retained' || job.firstDeliveredAt === undefined || job.followUntil === undefined) return { ok: false, reason: 'not_delivered' };
    if (this.now() > job.followUntil) return { ok: false, reason: 'window_closed' };
    if (job.outside.state === 'appended') return { ok: false, reason: 'already_appended' };
    if (job.rev !== expectedRev) return { ok: false, reason: 'stale_rev' };
    return { ok: true, job };
  }

  /**
   * One panel source-open request: `token` is a capability from this job's
   * sealed answer. It opens the local file this engine mapped it to, and
   * nothing else: no path is read from the request. Unknown, expired and
   * wrong-install jobs, and tokens this job never minted, all answer 410.
   * Rate limited per job and across jobs.
   */
  async open(jobId: string, token: unknown): Promise<ClaimResponse> {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (!job || privateAnswerInstallId(jobId) !== this.options.installId()) return gone();
    if (typeof token !== 'string' || !OPEN_TOKEN_PATTERN.test(token)) return { status: 400, body: { status: 'invalid' } };
    const path = job.opens?.get(token);
    if (!path || !this.options.openFile) return gone();
    if (!this.takeOpen(job)) return { status: 429, body: { status: 'rate_limited' }, retryAfterSeconds: 5 };
    // The answer's sources open only while every item it read is still eligible.
    if (!(await this.stillReleasable(job)) || this.jobs.get(jobId) !== job) return gone();
    // The final path as it is now: a regular file, never a symlink swapped in since the token was minted.
    let isFile = false;
    try {
      isFile = lstatSync(path).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) return gone();
    try {
      await this.options.openFile(path);
    } catch {
      return { status: 200, body: { status: 'failed' } };
    }
    return { status: 204, body: { status: 'opened' } };
  }

  /**
   * Whether a sealed answer may still be handed out: every item it read
   * passes the live guard now. If not, the answer is withdrawn for good: the
   * sealed bytes, the items and the source-open tokens are dropped and the
   * job is failed.
   */
  private async stillReleasable(job: Job): Promise<boolean> {
    const kind = job.outcome?.kind;
    if (kind !== 'sealed' && kind !== 'retained') return false;
    const ok = await checkPrivateEvidence(this.options.eligible, job.sealedItems ?? []);
    const current = (job.outcome as Job['outcome'])?.kind;
    // (An answer that read no item, such as "nothing was readable", holds no item text.)
    if (job.sealedItems !== undefined && ok.every(Boolean) && current === kind) return true;
    if (current === 'retained' || current === 'withdrawn') {
      // Phase 2: the withdrawal is told inside the next envelope, never as a plaintext status.
      this.withdraw(job);
      return false;
    }
    job.outcome = { kind: 'failed' };
    job.sealedItems = undefined;
    job.opens = undefined;
    return false;
  }

  /** Drops expired jobs (cancelling analyses no live job needs) and forgets shared answers past the dedupe window. */
  sweep(at = this.now()): void {
    for (const [id, job] of this.jobs) {
      if (job.expiresAt <= at) this.drop(id);
      else this.expireConsultSnapshot(job, at);
    }
    for (const [key, analysis] of this.shared) {
      if (analysis.createdAt + this.dedupeMs <= at || analysis.state === 'failed') this.shared.delete(key);
    }
  }

  private drop(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.claimAbort?.abort();
    this.detach(job);
    job.question = undefined;
    job.evidence = undefined;
    job.refresh = undefined;
    job.outcome = undefined;
    job.outside = { state: 'idle' };
    job.opens = undefined;
    job.sealedItems = undefined;
    this.forgetConsultSnapshot(job);
    this.jobs.delete(id);
  }

  private bindPolicy(): ConsultJobPolicy {
    const read = this.options.consultPolicy;
    if (!read) return OUTSIDE_HELP_OFF;
    try {
      const policy = read();
      // Anything but a policy object with a boolean flag binds outside help off (fail closed).
      return typeof policy === 'object' && policy !== null && typeof policy.outsideHelp === 'boolean' ? policy : OUTSIDE_HELP_OFF;
    } catch {
      return OUTSIDE_HELP_OFF;
    }
  }

  /* -------------------------------------------------------------- */
  /* Analyses: precompute, dedupe, supersede, the one model slot     */
  /* -------------------------------------------------------------- */

  /** Starts (or joins) the job's search-time analysis, and supersedes the caller's older precomputes. */
  private precompute(job: Job): void {
    const evidence = (job.evidence ?? []).filter(isPrivateEligible);
    if (evidence.length === 0 || job.question === undefined) return;
    const analysis = this.analysisFor(job.question, job.detail, evidence, undefined);
    this.attach(job, analysis);
    if (job.caller !== undefined) {
      for (const other of this.jobs.values()) {
        if (other !== job && other.caller === job.caller && other.claimKey === undefined && other.analysis !== analysis) {
          this.detach(other);
        }
      }
    }
    this.pump();
  }

  /**
   * The analysis for this question: a live shared one within the dedupe
   * window when `fresh` is not given, else a new one (queued, and shared
   * from now on). `claimedAt` marks a claim's own computation.
   */
  private analysisFor(
    question: string,
    detail: PrivateAnswerDetail,
    evidence: readonly PrivateEvidenceItem[],
    claimedAt: number | undefined,
    fresh = false,
  ): Analysis {
    // The same question in another detail is another answer.
    const key = `${detail}\u0000${questionKey(question)}`;
    const at = this.now();
    const existing = this.shared.get(key);
    if (!fresh && existing && existing.state !== 'failed' && existing.createdAt + this.dedupeMs > at) return existing;
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const analysis: Analysis = {
      key,
      detail,
      createdAt: at,
      claimedAt,
      question,
      evidence: evidence.slice(0, MAX_EVIDENCE_ITEMS),
      state: 'queued',
      result: undefined,
      failReason: undefined,
      startedAt: undefined,
      readyAt: undefined,
      stats: { calls: [] },
      abort: new AbortController(),
      jobs: new Set(),
      settled,
      settle,
    };
    this.shared.set(key, analysis);
    this.waiting.push(analysis);
    return analysis;
  }

  private attach(job: Job, analysis: Analysis): void {
    if (job.analysis === analysis) return;
    this.detach(job);
    job.analysis = analysis;
    analysis.jobs.add(job);
  }

  /** The job lets go of its analysis; an analysis no job needs any more is cancelled (or, when done, left to expire). */
  private detach(job: Job): void {
    const analysis = job.analysis;
    if (!analysis) return;
    job.analysis = undefined;
    analysis.jobs.delete(job);
    if (analysis.jobs.size > 0) return;
    if (analysis.state === 'queued' || analysis.state === 'running') this.cancel(analysis);
    else if (this.shared.get(analysis.key) !== analysis) this.release(analysis);
  }

  private cancel(analysis: Analysis): void {
    if (this.shared.get(analysis.key) === analysis) this.shared.delete(analysis.key);
    const index = this.waiting.indexOf(analysis);
    if (index >= 0) {
      this.waiting.splice(index, 1);
      this.finish(analysis, 'failed', 'aborted');
      return;
    }
    // Running: the run settles it as aborted and frees the slot.
    analysis.abort.abort();
  }

  /**
   * Drops items the guard no longer vouches for from the cached evidence of
   * every job attached to this analysis, so their text is not kept until the
   * job is claimed or expires.
   */
  private forget(analysis: Analysis, items: readonly PrivateEvidenceItem[]): void {
    const gone = new Set(items.map(privateEvidenceKey).filter((key): key is string => key !== undefined));
    for (const job of analysis.jobs) {
      if (!job.evidence) continue;
      job.evidence = job.evidence.filter((item) => {
        const key = privateEvidenceKey(item);
        return key === undefined ? !items.includes(item) : !gone.has(key);
      });
    }
  }

  /** Forgets a settled analysis's answer and evidence. */
  private release(analysis: Analysis): void {
    analysis.result = undefined;
    analysis.question = undefined;
    analysis.evidence = undefined;
  }

  private finish(analysis: Analysis, state: 'done' | 'failed', reason?: AnalysisTiming['reason']): void {
    if (analysis.state === 'done' || analysis.state === 'failed') return;
    analysis.state = state;
    analysis.failReason = state === 'failed' ? reason ?? 'error' : undefined;
    analysis.readyAt = this.now();
    analysis.question = undefined;
    analysis.evidence = undefined;
    if (state === 'failed') {
      analysis.result = undefined;
      if (this.shared.get(analysis.key) === analysis) this.shared.delete(analysis.key);
    }
    if (analysis.jobs.size === 0 && this.shared.get(analysis.key) !== analysis) this.release(analysis);
    analysis.settle();
  }

  /** The next analysis for the slot: the oldest claim, else the newest precompute still worth running. */
  private next(): Analysis | undefined {
    const at = this.now();
    for (let index = this.waiting.length - 1; index >= 0; index -= 1) {
      const analysis = this.waiting[index]!;
      const claimed = analysis.claimedAt !== undefined || [...analysis.jobs].some((job) => job.claimKey !== undefined);
      if (!claimed && (analysis.jobs.size === 0 || analysis.createdAt + this.precomputeWindowMs <= at)) {
        // Unclaimed and stale (or orphaned): abandoned, never started.
        this.waiting.splice(index, 1);
        if (this.shared.get(analysis.key) === analysis) this.shared.delete(analysis.key);
        for (const job of [...analysis.jobs]) {
          job.analysis = undefined;
          analysis.jobs.delete(job);
        }
        this.finish(analysis, 'failed', 'aborted');
      }
    }
    let pick: Analysis | undefined;
    for (const analysis of this.waiting) {
      if (analysis.claimedAt !== undefined && (pick?.claimedAt === undefined || analysis.claimedAt < pick.claimedAt)) pick = analysis;
    }
    pick ??= this.waiting[this.waiting.length - 1];
    if (pick) this.waiting.splice(this.waiting.indexOf(pick), 1);
    return pick;
  }

  private pump(): void {
    if (this.running || this.resetting) return;
    const analysis = this.next();
    if (!analysis) return;
    this.running = analysis;
    void this.run(analysis);
  }

  private async run(analysis: Analysis): Promise<void> {
    const { abort } = analysis;
    analysis.state = 'running';
    analysis.startedAt = this.now();
    const endActivity = this.beginActivity();
    let freed = false;
    // Frees the slot exactly once, and starts the next analysis.
    const free = () => {
      if (freed) return;
      freed = true;
      clearTimeout(deadlineTimer);
      endActivity();
      if (this.running === analysis) this.running = undefined;
      this.pump();
    };
    // Bounded from its start: the slot is freed when it fires, even if the
    // model ignores its abort signal, and the model is reset in the background.
    let timedOut = false;
    const deadlineTimer = setTimeout(() => {
      if (freed) return;
      timedOut = true;
      this.audit('analysis_deadline');
      this.finish(analysis, 'failed', 'deadline');
      abort.abort();
      this.resetInBackground();
      free();
    }, this.timeoutFor(analysis.detail));
    (deadlineTimer as { unref?: () => void }).unref?.();
    const question = analysis.question ?? '';
    const cached = analysis.evidence ?? [];
    let evidence: readonly PrivateEvidenceItem[] = [];
    const work = (async () => {
      if (abort.signal.aborted) throw new AnalysisStop('aborted');
      if (cached.length === 0) throw new AnalysisStop('no_evidence');
      // Dispatch: only items the live guard vouches for now go on to the
      // model (which checks again before each of its own submissions). A
      // dropped item's cached text leaves the analysis and its jobs now.
      const checkStarted = this.now();
      const ok = await checkPrivateEvidence(this.options.eligible, cached);
      evidence = cached.filter((_, index) => ok[index]);
      analysis.stats.recheckMs = this.now() - checkStarted;
      analysis.stats.dropped = cached.length - evidence.length;
      if (evidence.length < cached.length) this.forget(analysis, cached.filter((_, index) => !ok[index]));
      if (abort.signal.aborted) throw new AnalysisStop('aborted');
      if (evidence.length === 0) throw new AnalysisStop('no_evidence');
      const modelStarted = this.now();
      let used: readonly number[] | undefined;
      try {
        const result = await this.options.model().answerPrivately(question, evidence, abort.signal, {
          evidence: (stats) => {
            analysis.stats.items = stats.items;
            analysis.stats.unreadable = stats.unreadable;
            analysis.stats.evidenceBytes = stats.bytes;
            used = stats.used;
          },
          modelCall: (call) => {
            analysis.stats.calls.push(call);
          },
        }, {
          detail: analysis.detail,
          // The consult snapshot is built only for a job that bound outside
          // help on; an install without it does no extra cloning.
          ...([...analysis.jobs].some((job) => job.policy.outsideHelp) ? { consult: true } : {}),
        });
        return { result, used };
      } catch (error) {
        if (error instanceof NoPrivateEvidenceError) throw new AnalysisStop('no_evidence');
        throw error;
      } finally {
        analysis.stats.modelMs = this.now() - modelStarted;
      }
    })();
    work.catch(() => undefined);
    const stopped = new Promise<void>((resolve) => {
      if (abort.signal.aborted) resolve();
      abort.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    try {
      const done = await Promise.race([work, stopped]);
      if (timedOut) return;
      if (abort.signal.aborted || done === undefined) {
        this.finish(analysis, 'failed', 'aborted');
        return;
      }
      analysis.result = {
        ...preparedAnswer(done.result),
        usedKeys: usedKeys(evidence, done.used),
        usedItems: usedItems(evidence, done.used).map(privateEvidenceIdentity),
        consult: done.result.consult,
      };
      this.finish(analysis, 'done');
    } catch (error) {
      if (!timedOut) this.finish(analysis, 'failed', error instanceof AnalysisStop ? error.reason : 'error');
    } finally {
      free();
    }
  }

  /* -------------------------------------------------------------- */
  /* Claims                                                          */
  /* -------------------------------------------------------------- */

  /** Starts the claim's work; resolves once the job is ready or failed. */
  private startClaim(job: Job, panelKey: CryptoKey): Promise<void> {
    let claimSettled: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      claimSettled = resolve;
    });
    const abort = new AbortController();
    job.claimAbort = abort;
    const claimedAt = this.now();
    // A queued precompute moves ahead of other precomputes now, while the
    // evidence is re-read.
    if (job.analysis && job.analysis.state === 'queued') job.analysis.claimedAt ??= claimedAt;
    const timing: AnalysisTiming = { outcome: 'failed', reason: 'error', queuedMs: 0, calls: [] };
    let settled = false;
    // Answers come first: the sniffer and other background model work yield
    // from the claim until this job settles, however it settles.
    const endActivity = this.beginActivity();
    const settle = (outcome: Job['outcome'], reason?: AnalysisTiming['reason']) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (this.jobs.get(job.id) === job) job.outcome = outcome;
      // The sealed bytes (or the failure) are all the job keeps.
      this.detach(job);
      timing.outcome = outcome?.kind === 'sealed' || outcome?.kind === 'retained' ? 'sealed' : 'failed';
      if (reason) timing.reason = reason;
      timing.totalMs = this.now() - claimedAt;
      endActivity();
      this.logTiming(timing);
      claimSettled();
    };
    // The deadline runs from the claim, so every claimed job is ready or
    // failed within analysisTimeoutMs whatever the queue, the evidence
    // refresh or the model do.
    const deadlineTimer = setTimeout(() => {
      if (settled) return;
      this.audit('analysis_deadline');
      // An analysis only this job needs is cancelled with it; when it was
      // running, the model is reset in the background (it may ignore its
      // abort signal), and the next analysis waits for that reset.
      const analysis = job.analysis;
      const hung = analysis?.state === 'running' && analysis.jobs.size === 1;
      settle({ kind: 'failed' }, 'deadline');
      abort.abort();
      if (hung) this.resetInBackground();
    }, this.timeoutFor(job.detail));
    (deadlineTimer as { unref?: () => void }).unref?.();
    // A job dropped (expired) while it waits settles at once.
    abort.signal.addEventListener('abort', () => settle({ kind: 'failed' }, 'aborted'), { once: true });
    const stopped = new Promise<void>((resolve) => {
      if (abort.signal.aborted) resolve();
      abort.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const record = (analysis: Analysis) => {
      timing.recheckMs = analysis.stats.recheckMs;
      timing.dropped = analysis.stats.dropped;
      timing.items = analysis.stats.items;
      timing.unreadable = analysis.stats.unreadable;
      timing.evidenceBytes = analysis.stats.evidenceBytes;
      timing.modelMs = analysis.stats.modelMs;
      timing.calls = [...analysis.stats.calls];
      if (analysis.startedAt !== undefined) {
        timing.queuedMs = Math.max(0, analysis.startedAt - Math.max(analysis.createdAt, analysis.claimedAt ?? analysis.createdAt));
      }
      // A shared (deduplicated) analysis can be ready before this job's own
      // search: its answer was there when this search began.
      if (analysis.readyAt !== undefined) timing.searchToReadyMs = Math.max(0, analysis.readyAt - job.createdAt);
    };
    const run = async () => {
      const refresh = job.refresh;
      const question = job.question ?? '';
      // The claim's computation holds the question from here; the job does not.
      job.question = undefined;
      job.evidence = undefined;
      job.refresh = undefined;
      const refreshStarted = this.now();
      // No search to judge the items by now: nothing is read (fail closed).
      const found = refresh ? await refresh(abort.signal) : [];
      if (refresh) timing.refreshMs = this.now() - refreshStarted;
      // A refresh that finished after the deadline (or after the job was
      // dropped) must not start inference.
      if (settled || abort.signal.aborted) return;
      const evidence = found.filter(isPrivateEligible).slice(0, MAX_EVIDENCE_ITEMS);
      timing.matched = evidence.length;
      if (evidence.length === 0) {
        settle({ kind: 'failed' }, 'no_evidence');
        return;
      }
      const current = new Set(evidence.map(privateEvidenceKey).filter((key): key is string => key !== undefined));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let analysis = job.analysis;
        // A precompute (or a shared answer) read the search-time evidence and
        // is checked against the current evidence below; a computation made
        // for this claim reads the current evidence itself.
        const precomputed = analysis !== undefined;
        if (!analysis) {
          analysis = this.analysisFor(question, job.detail, evidence, claimedAt, true);
          this.attach(job, analysis);
        } else if (analysis.state === 'queued' || analysis.state === 'running') {
          analysis.claimedAt ??= claimedAt;
        }
        this.pump();
        await Promise.race([analysis.settled, stopped]);
        if (settled) return;
        record(analysis);
        const result = analysis.state === 'done' ? analysis.result : undefined;
        // Every item the answer read must still pass the live guard, checked
        // now (not against the claim-time search, which may be minutes old),
        // and again once it is sealed, just before it is released.
        const stillReadable = async () => result !== undefined
          && (await checkPrivateEvidence(this.options.eligible, result.usedItems)).every(Boolean);
        if (result && (!precomputed || stillEligible(result.usedKeys, current)) && await stillReadable()) {
          if (settled) return;
          const plaintext = this.withOpenTokens(job, result.plaintext, result.localPaths);
          // The payload contract is enforced here, before first delivery, on
          // every job: the limits and byte budgets in private-answer-payload.ts.
          let outcome: Job['outcome'];
          if (job.followUp) {
            // Follow-up collection keeps the bounded plaintext and seals it
            // afresh per request; the envelope must fit the fixed size now
            // (it always does after budgeting; a rejection fails the job).
            // Retained in its fitted form: exactly the fields and bytes the envelope carries.
            const retained = retainedAnswer(plaintext);
            try {
              padPrivateAnswerEnvelope(serializePrivateAnswerEnvelope({
                v: 1,
                rev: 1,
                state: 'answer',
                answer: retained.answer,
                citations: [...retained.citations],
                ...(retained.unanswered ? { unanswered: [...retained.unanswered] } : {}),
                followSeconds: Math.ceil(this.followUpWindowMs / 1000),
                outside: { state: 'idle' },
              }));
            } catch {
              job.opens = undefined;
              settle({ kind: 'failed' }, 'error');
              return;
            }
            outcome = { kind: 'retained', answer: retained };
          } else {
            const sealed = await sealPrivateAnswer(job.id, panelKey, padPrivateAnswerPlaintext(serializePrivateAnswerPlaintext(plaintext)));
            outcome = { kind: 'sealed', sealed };
          }
          if (settled) return;
          if (await stillReadable()) {
            if (settled) return;
            timing.precomputed = precomputed;
            timing.waitAtClaimMs = this.now() - claimedAt;
            job.sealedItems = result.usedItems;
            if (outcome.kind === 'retained') {
              job.rev = 1;
              // The consult snapshot (C4b): exactly what the gate compares
              // against, built from the analysis that produced the answer (a
              // reused precompute brings its search-time pack). Frozen; its
              // retention clock starts at first delivery.
              // Validated, cloned and frozen here, on this job's own path only.
              const input = consultSnapshotInput(result.consult);
              job.consult.snapshot = input ? consultSnapshot(question, outcome.answer, input, result.usedItems) : undefined;
            }
            settle(outcome);
            return;
          }
          job.opens = undefined;
        }
        if (settled) return;
        // Failed, or read an item that is no longer Private-eligible: this
        // answer is discarded for this job (never sealed or released), and a
        // precompute is computed again once from the current evidence.
        // No later search shares an answer that was discarded.
        if (result && this.shared.get(analysis.key) === analysis) this.shared.delete(analysis.key);
        this.detach(job);
        if (!precomputed) {
          settle({ kind: 'failed' }, result ? 'no_evidence' : analysis.failReason ?? 'error');
          return;
        }
      }
      settle({ kind: 'failed' }, 'error');
    };
    run().catch(() => {
      settle({ kind: 'failed' }, 'error');
    });
    return done;
  }

  /** The hard deadline for an analysis (and a claim) of this detail. */
  private timeoutFor(detail: PrivateAnswerDetail): number {
    return detail === 'full' ? Math.max(this.analysisTimeoutMs, this.fullAnalysisTimeoutMs) : this.analysisTimeoutMs;
  }

  /** Begins one answer activity; the returned function ends exactly that one, once. */
  private beginActivity(): () => void {
    // A fresh answer is starting: a consult writer in flight is killed (C4b).
    try {
      this.options.onAnswerActivity?.();
    } catch {
      // A hook never fails a job.
    }
    let release: (() => void) | void;
    try {
      release = this.options.activity?.begin();
    } catch {
      // A hook never fails a job.
      return () => undefined;
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      try {
        if (typeof release === 'function') release();
        else this.options.activity?.end();
      } catch {
        // A hook never fails a job.
      }
    };
  }

  private logTiming(timing: AnalysisTiming): void {
    try {
      (this.options.log ?? defaultLog)(formatAnalysisTiming(timing));
    } catch {
      // Logging never fails a job.
    }
  }

  private resetInBackground(): void {
    let reset: Promise<unknown>;
    try {
      reset = Promise.resolve(this.options.model().reset?.());
    } catch {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.resetTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const settled: Promise<void> = Promise.race([reset.then(() => undefined, () => undefined), timeout]).finally(() => {
      clearTimeout(timer);
      if (this.resetting === settled) this.resetting = undefined;
      this.pump();
    });
    this.resetting = settled;
  }

  private takePoll(job: Job): boolean {
    const at = this.now();
    job.pollTokens = Math.min(this.pollRate.capacity, job.pollTokens + ((at - job.pollRefilledAt) / 1000) * this.pollRate.refillPerSecond);
    job.pollRefilledAt = at;
    if (job.pollTokens < 1) return false;
    job.pollTokens -= 1;
    return true;
  }

  /**
   * The plaintext this job seals: each source with a local file opens on
   * the Mac (`open: {kind:'mac', token}`, a fresh random token mapped to
   * that file for this job only; a shared analysis gives every job its own
   * tokens); any other keeps its web address, if it has one.
   */
  private withOpenTokens(job: Job, plaintext: PrivateAnswerPlaintextV1, localPaths: readonly (string | undefined)[]): PrivateAnswerPlaintextV1 {
    if (!this.options.openFile) return plaintext;
    const opens = new Map<string, string>();
    const citations = plaintext.citations.map((citation, index) => {
      const path = localPaths[index];
      if (!path) return citation;
      const token = randomBytes(32).toString('base64url');
      opens.set(token, path);
      return { ...citation, open: { kind: 'mac' as const, token } };
    });
    job.opens = opens.size > 0 ? opens : undefined;
    return { ...plaintext, citations };
  }

  private takeOpen(job: Job): boolean {
    const at = this.now();
    this.openTokens = Math.min(this.openRateGlobal.capacity, this.openTokens + ((at - this.openRefilledAt) / 1000) * this.openRateGlobal.refillPerSecond);
    this.openRefilledAt = at;
    job.openTokens = Math.min(this.openRate.capacity, job.openTokens + ((at - job.openRefilledAt) / 1000) * this.openRate.refillPerSecond);
    job.openRefilledAt = at;
    if (this.openTokens < 1 || job.openTokens < 1) return false;
    this.openTokens -= 1;
    job.openTokens -= 1;
    return true;
  }

  private takeToken(): boolean {
    const at = this.now();
    this.tokens = Math.min(this.claimRate.capacity, this.tokens + ((at - this.refilledAt) / 1000) * this.claimRate.refillPerSecond);
    this.refilledAt = at;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** The identities of the items the answer read (all of them when the model did not say), or undefined if one has none. */
function usedKeys(evidence: readonly PrivateEvidenceItem[], used: readonly number[] | undefined): readonly string[] | undefined {
  const read = used === undefined
    ? evidence
    : used.map((index) => evidence[index]).filter((item): item is PrivateEvidenceItem => item !== undefined);
  if (used !== undefined && read.length !== used.length) return undefined;
  const keys: string[] = [];
  for (const item of read) {
    const key = privateEvidenceKey(item);
    if (key === undefined) return undefined;
    keys.push(key);
  }
  return keys;
}

/** The only fields an identity keeps: what the guard and the claim-time match need (no text field can enter). */
const IDENTITY_FIELDS = [
  'corpusId', 'trustDomain', 'trust_domain', 'trustTier', 'trust_tier',
  'tier', 'content_tier', 'contentTier', 'metadata_tier', 'metadataTier',
] as const;
/** The source-item identifiers the guard (`localItemId`) and the claim-time match (`privateEvidenceKey`) read; nothing else of it is kept. */
const SOURCE_ITEM_FIELDS = ['family', 'provider', 'accountScope', 'providerItemId', 'localItemId'] as const;

/** The identifier fields of a source item, or undefined when it carries none. */
function sourceItemIdentity(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kept: Record<string, string> = {};
  for (const key of SOURCE_ITEM_FIELDS) {
    const field = record[key];
    if (typeof field === 'string') kept[key] = field;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * An evidence item as the guard needs it, without its text: an allowlist of
 * its corpus, trust domain and tier fields and its store identifiers (the
 * source item's family, provider, account scope and ids, top-level or under
 * provenance), so an answer kept for the dedupe window or a sealed job holds
 * no passages, tables, titles or any field added later.
 */
export function privateEvidenceIdentity(item: PrivateEvidenceItem): PrivateEvidenceItem {
  const kept: Record<string, unknown> = {};
  for (const key of IDENTITY_FIELDS) {
    const value = item[key];
    if (typeof value === 'string') kept[key] = value;
  }
  const sourceItem = sourceItemIdentity(item.sourceItem);
  if (sourceItem) kept.sourceItem = sourceItem;
  const provenance = asRecord(item.provenance);
  const provenanceItem = sourceItemIdentity(provenance?.sourceItem);
  if (provenanceItem) kept.provenance = { sourceItem: provenanceItem };
  return kept;
}

/** The evidence items the answer read (all of them when the model did not say). */
function usedItems(evidence: readonly PrivateEvidenceItem[], used: readonly number[] | undefined): readonly PrivateEvidenceItem[] {
  if (used === undefined) return evidence;
  const read = used.map((index) => evidence[index]);
  // An index the evidence does not have: the answer's sources are unknown, so all of it is checked.
  return read.every((item) => item !== undefined) ? read as PrivateEvidenceItem[] : evidence;
}

/** Every item the answer read is among the current Private-eligible evidence. An answer with unknown sources never is. */
function stillEligible(used: readonly string[] | undefined, current: ReadonlySet<string>): boolean {
  return used !== undefined && used.every((key) => current.has(key));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function gone(): ClaimResponse {
  return { status: 410, body: { status: 'gone' } };
}

/** The decrypted payload, field by field: text only, bounded by the payload contract. */
export function plaintextOf(result: { answer: unknown; citations?: unknown; unanswered?: unknown }): PrivateAnswerPlaintextV1 {
  return preparedAnswer(result).plaintext;
}

/**
 * The payload before its open tokens, and each source's local file (index
 * aligned with `plaintext.citations`), which stays on this computer.
 */
function preparedAnswer(result: { answer: unknown; citations?: unknown; unanswered?: unknown }): {
  plaintext: PrivateAnswerPlaintextV1;
  localPaths: (string | undefined)[];
} {
  const prepared = preparePrivateAnswer(result);
  return {
    plaintext: {
      v: 1,
      answer: prepared.answer,
      citations: prepared.citations,
      ...(prepared.unanswered.length > 0 ? { unanswered: prepared.unanswered } : {}),
    },
    localPaths: prepared.localPaths,
  };
}

/** The model's consult metadata as the analysis keeps it: frozen, or undefined when the model supplied none or a malformed one. */
function consultSnapshotInput(value: unknown): PrivateAnswerConsultSnapshotInput | undefined {
  const record = asRecord(value);
  const verdict = asRecord(record?.verdict);
  const pack = asRecord(record?.pack);
  if (!record || !verdict || !pack || typeof verdict.noAnswer !== 'boolean') return undefined;
  if (verdict.sufficient !== undefined && typeof verdict.sufficient !== 'boolean') return undefined;
  if (typeof pack.question !== 'string' || !Array.isArray(pack.candidates)) return undefined;
  return deepFreeze({
    verdict: { sufficient: verdict.sufficient as boolean | undefined, noAnswer: verdict.noAnswer },
    pack: structuredClone(pack) as unknown as PrivateAnswerConsultSnapshotInput['pack'],
  });
}

/** The job's consult snapshot: the analysis's pack and verdict, the question, and the answer and gaps exactly as retained. Deep-frozen. */
function consultSnapshot(
  question: string,
  retained: RetainedAnswer,
  input: PrivateAnswerConsultSnapshotInput,
  items: readonly PrivateEvidenceItem[],
): PrivateAnswerConsultSnapshot {
  return deepFreeze({
    question,
    answer: retained.answer,
    gaps: [...(retained.unanswered ?? [])],
    verdict: { sufficient: input.verdict.sufficient, noAnswer: input.verdict.noAnswer },
    pack: input.pack,
    items: items.map((item) => structuredClone(item)),
  });
}

/** Freezes a plain-data value and everything reachable from it. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}

/** The first answer a follow-up job retains: the plaintext's fields in their budgeted form, frozen. */
function retainedAnswer(plaintext: PrivateAnswerPlaintextV1): RetainedAnswer {
  const fitted = fitFirstAnswer(plaintext);
  return Object.freeze({
    answer: fitted.answer,
    citations: Object.freeze(fitted.citations),
    unanswered: fitted.unanswered && fitted.unanswered.length > 0 ? Object.freeze(fitted.unanswered) : undefined,
  });
}

/** One job's follow-up state as the C4b writer reads it (`outsideSeam`): clocks and states only, no text. */
export interface PrivateAnswerFollowUpState {
  rev: number;
  /** `pending`: claimed, not yet delivered. */
  state: 'pending' | 'answer' | 'withdrawn';
  outside: PrivateAnswerOutsideBlockV1['state'];
  policy: ConsultJobPolicy;
  panelCapability: PrivateAnswerPanelCapability;
  createdAt: number;
  expiresAt: number;
  firstDeliveredAt: number | undefined;
  followUntil: number | undefined;
  lastCollectedAt: number | undefined;
}

/**
 * The consult snapshot (design §A.3), as the orchestrator reads it: the
 * evidence as the pack, plus the question, answer and gaps exactly as the
 * writer will see them, the verdict, and the identities (no text) of the
 * items the answer read, for the eligibility checks E1 and E2. Deep-frozen.
 */
export interface PrivateAnswerConsultSnapshot {
  readonly question: string;
  readonly answer: string;
  readonly gaps: readonly string[];
  readonly verdict: { readonly sufficient: boolean | undefined; readonly noAnswer: boolean };
  readonly pack: PrivateAnswerConsultSnapshotInput['pack'];
  readonly items: readonly PrivateEvidenceItem[];
}

export type OutsideSeamResult =
  | { ok: true; rev: number }
  | { ok: false; reason: 'unknown' | 'not_delivered' | 'withdrawn' | 'already_appended' | 'stale_rev' | 'window_closed' };

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

export interface PrivateAnswerHandlerOptions {
  jobs: PrivateAnswerJobs;
  /** Only relayed requests are served: the panel reaches the engine through the relay. */
  isRelayed: (request: Request) => boolean;
  /** Panel origins beyond ChatGPT's widget sandbox (the dedicated `_meta.ui.domain`). */
  extraOrigins?: () => readonly string[];
}

export function isPrivateAnswerRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith('/private/');
}

export function withPrivateAnswerRoute(
  privateAnswer: (request: Request) => Promise<Response>,
  rest: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) => (isPrivateAnswerRequest(request) ? privateAnswer(request) : rest(request));
}

export function createPrivateAnswerHandler(options: PrivateAnswerHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const route = url.search ? undefined : privateAnswerRoute(url.pathname);
    const jobId = route?.jobId;
    if (!options.isRelayed(request) || !route || !jobId) return reply({ status: 404, body: { status: 'gone' } });
    if (request.method !== 'POST') return reply({ status: 405, body: { status: 'invalid' } }, { Allow: 'POST' });
    if (!isPanelOrigin(request.headers.get('origin'), options.extraOrigins?.() ?? [])) {
      return reply({ status: 403, body: { status: 'forbidden' } });
    }
    const text = await boundedText(request, PRIVATE_ANSWER_MAX_REQUEST_BYTES);
    if (text === undefined) return reply({ status: 413, body: { status: 'invalid' } });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return reply({ status: 400, body: { status: 'invalid' } });
    }
    const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
    if (!record || record.v !== 1) return reply({ status: 400, body: { status: 'invalid' } });
    if (route.action === 'open') return reply(await options.jobs.open(jobId, record.open));
    // The capability handshake: `cap: 2` from every new panel, in every request.
    return reply(await options.jobs.claim(jobId, record.publicKey, record.cap === PRIVATE_ANSWER_PANEL_CAPABILITY ? PRIVATE_ANSWER_PANEL_CAPABILITY : 1));
  };
}

function reply(claim: ClaimResponse, extra: Record<string, string> = {}): Response {
  if (claim.status === 204) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', ...extra } });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...extra,
  };
  if (claim.retryAfterSeconds !== undefined) headers['Retry-After'] = String(claim.retryAfterSeconds);
  return new Response(JSON.stringify(claim.body), { status: claim.status, headers });
}

async function boundedText(request: Request, max: number): Promise<string | undefined> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
