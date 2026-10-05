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
 * Pending polls by the claiming key are rate limited per job (429), never
 * destructive. Unknown, expired (ten minutes from creation) and wrong-install
 * jobs answer 410 `gone`: the endpoint is no oracle for which ids existed.
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
  PRIVATE_ANSWER_JOB_TTL_MS,
  PRIVATE_MATCH_COUNT_CAP,
  type PrivateAnswerCitation,
  type PrivateAnswerDetail,
  type PrivateAnswerModel,
  type PrivateAnswerModelCall,
  type PrivateAnswerPlaintextV1,
  type PrivateEvidenceGuard,
  type PrivateEvidenceItem,
  type PrivateMatchSummary,
  NoPrivateEvidenceError,
  checkPrivateEvidence,
} from './private-answer-contract.ts';
import { importPanelPublicKey, padPrivateAnswerPlaintext, sealPrivateAnswer, type SealedPrivateAnswer } from './private-answer-crypto.ts';

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
   * between, so the answer never waits on it.
   */
  activity?: { begin(): void; end(): void };
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

interface Job {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly caller: string | undefined;
  readonly detail: PrivateAnswerDetail;
  question: string | undefined;
  evidence: readonly PrivateEvidenceItem[] | undefined;
  refresh: PrivateEvidenceRefresh | undefined;
  analysis: Analysis | undefined;
  claimKey?: string;
  pollTokens: number;
  pollRefilledAt: number;
  outcome?: { kind: 'sealed'; sealed: SealedPrivateAnswer } | { kind: 'failed' } | undefined;
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

const MAX_ANSWER_CHARS = 64 * 1024;
const MAX_CITATIONS = 20;
const MAX_UNANSWERED = 10;
const MAX_CITATION_TEXT = 300;
const MAX_QUESTION_CHARS = 4_000;
const MAX_URL_CHARS = 2_048;
/** A source-open token: 32 random bytes, base64url. */
const OPEN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
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
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

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
    const job: Job = {
      id,
      createdAt: at,
      expiresAt: at + this.ttlMs,
      caller: input.caller,
      detail: input.detail === 'full' ? 'full' : 'summary',
      question: input.question.slice(0, MAX_QUESTION_CHARS),
      evidence: input.evidence.slice(0, MAX_EVIDENCE_ITEMS),
      refresh: input.refresh,
      analysis: undefined,
      pollTokens: this.pollRate.capacity,
      pollRefilledAt: at,
      openTokens: this.openRate.capacity,
      openRefilledAt: at,
    };
    this.jobs.set(id, job);
    if (this.options.precompute !== false) this.precompute(job);
    return { count, panelState: 'ready', jobId: id, ...(job.detail === 'full' ? { detail: 'full' as const } : {}) };
  }

  /** One panel POST: claim, poll, or collect (idempotent for the claiming key until expiry). */
  async claim(jobId: string, publicKey: unknown): Promise<ClaimResponse> {
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
    // Every hand-out of the sealed bytes, not only the first: an item the
    // answer read that is no longer eligible withdraws it for good.
    if (!(await this.stillReleasable(job))) return this.jobs.get(jobId) === job ? { status: 200, body: { status: 'failed' } } : gone();
    if (this.jobs.get(jobId) !== job || job.outcome !== outcome) return job.outcome?.kind === 'failed' ? { status: 200, body: { status: 'failed' } } : gone();
    return { status: 200, body: { status: 'ready', v: 1, ...outcome.sealed } };
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
    if (job.outcome?.kind !== 'sealed') return false;
    const ok = await checkPrivateEvidence(this.options.eligible, job.sealedItems ?? []);
    // (An answer that read no item, such as "nothing was readable", holds no item text.)
    if (job.sealedItems !== undefined && ok.every(Boolean) && job.outcome?.kind === 'sealed') return true;
    job.outcome = { kind: 'failed' };
    job.sealedItems = undefined;
    job.opens = undefined;
    return false;
  }

  /** Drops expired jobs (cancelling analyses no live job needs) and forgets shared answers past the dedupe window. */
  sweep(at = this.now()): void {
    for (const [id, job] of this.jobs) if (job.expiresAt <= at) this.drop(id);
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
    job.opens = undefined;
    job.sealedItems = undefined;
    this.jobs.delete(id);
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
    this.beginActivity();
    let freed = false;
    // Frees the slot exactly once, and starts the next analysis.
    const free = () => {
      if (freed) return;
      freed = true;
      clearTimeout(deadlineTimer);
      this.endActivity();
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
        }, { detail: analysis.detail });
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
        usedItems: usedItems(evidence, done.used).map(identityOnly),
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
    this.beginActivity();
    const settle = (outcome: Job['outcome'], reason?: AnalysisTiming['reason']) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (this.jobs.get(job.id) === job) job.outcome = outcome;
      // The sealed bytes (or the failure) are all the job keeps.
      this.detach(job);
      timing.outcome = outcome?.kind ?? 'failed';
      if (reason) timing.reason = reason;
      timing.totalMs = this.now() - claimedAt;
      this.endActivity();
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
          const sealed = await sealPrivateAnswer(job.id, panelKey, padPrivateAnswerPlaintext(JSON.stringify(plaintext)));
          if (settled) return;
          if (await stillReadable()) {
            if (settled) return;
            timing.precomputed = precomputed;
            timing.waitAtClaimMs = this.now() - claimedAt;
            job.sealedItems = result.usedItems;
            settle({ kind: 'sealed', sealed });
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

  private beginActivity(): void {
    try {
      this.options.activity?.begin();
    } catch {
      // A hook never fails a job.
    }
  }

  private endActivity(): void {
    try {
      this.options.activity?.end();
    } catch {
      // A hook never fails a job.
    }
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

/** Text-bearing fields of an evidence item; an identity kept for the guard drops them. */
const TEXT_FIELDS = new Set(['chunks', 'text', 'excerpt', 'passage', 'passages', 'snippet', 'internalContent', 'content', 'facts']);

/**
 * An evidence item as the guard needs it, without its text: its corpus,
 * trust domain, tier fields and store identity (provenance keeps only its
 * source item and citation title), so an answer kept for the dedupe window
 * or a sealed job does not hold the items' passages.
 */
function identityOnly(item: PrivateEvidenceItem): PrivateEvidenceItem {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (TEXT_FIELDS.has(key)) continue;
    if (key === 'provenance') {
      const provenance = asRecord(value);
      const citation = asRecord(provenance?.citation);
      kept.provenance = {
        ...(provenance?.sourceItem !== undefined ? { sourceItem: provenance.sourceItem } : {}),
        ...(citation?.title !== undefined ? { citation: { title: citation.title } } : {}),
      };
      continue;
    }
    kept[key] = value;
  }
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

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(UNSAFE_CHARS, ' ').trim().slice(0, max);
  return text || undefined;
}

/** The decrypted payload, field by field: text only, bounded. */
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
  const citations: PrivateAnswerCitation[] = [];
  const localPaths: (string | undefined)[] = [];
  for (const value of Array.isArray(result.citations) ? result.citations : []) {
    if (citations.length >= MAX_CITATIONS) break;
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    const citation: PrivateAnswerCitation = {};
    const title = clean(record.title, MAX_CITATION_TEXT);
    const source = clean(record.source, MAX_CITATION_TEXT);
    const date = clean(record.date, 32);
    const url = httpsUrl(record.url);
    if (title) citation.title = title;
    if (source) citation.source = source;
    if (date) citation.date = date;
    if (url) citation.open = { kind: 'web', url };
    if (Object.keys(citation).length > 0) {
      citations.push(citation);
      localPaths.push(typeof record.localPath === 'string' && record.localPath.startsWith('/') ? record.localPath : undefined);
    }
  }
  const unanswered: string[] = [];
  for (const value of Array.isArray(result.unanswered) ? result.unanswered : []) {
    if (unanswered.length >= MAX_UNANSWERED) break;
    const line = clean(value, MAX_CITATION_TEXT);
    if (line) unanswered.push(line);
  }
  return {
    plaintext: {
      v: 1,
      answer: (typeof result.answer === 'string' ? result.answer : '').replace(UNSAFE_CHARS, '').slice(0, MAX_ANSWER_CHARS),
      citations,
      ...(unanswered.length > 0 ? { unanswered } : {}),
    },
    localPaths,
  };
}

/** An https URL, bounded, or undefined: the panel renders it as a link. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS || value.replace(UNSAFE_CHARS, '') !== value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

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
    return reply(await options.jobs.claim(jobId, record.publicKey));
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
