/**
 * One-time private-answer jobs and the engine's `/private/<id>` endpoint.
 *
 * A ChatGPT answer whose question matches Private items creates a job here
 * (when a private model is ready) at the moment its tool result is built, so
 * the id exists only once ChatGPT can see it. ChatGPT gets only the job id and
 * the count, in the tool result's widget-only `_meta`. The private answer
 * panel collects the answer itself, directly from the relay:
 *
 * 1. It POSTs an ephemeral ECDH public key. The first key to arrive claims
 *    the job. Another key gets 409 `claimed`: the panel says the answer was
 *    already opened elsewhere, and this Mac writes a content-free audit line.
 * 2. Claiming starts the private model. The evidence is searched again at
 *    that moment (current tiers, not the search-time cache), and anything not
 *    Private-eligible now (Secret included) is dropped. Until the model is
 *    done, the claiming key gets 202 `pending` with Retry-After.
 * 3. When it is done, the claiming key gets 200 `ready` with the answer
 *    sealed to that key (private-answer-crypto.ts), padded to a size bucket
 *    so the ciphertext length does not reveal the answer length. The same key gets the
 *    same sealed bytes again until the job expires, so a replay of the
 *    panel's request (by anyone who saw it) is harmless and cannot consume
 *    the answer: only the holder of the panel's private key can open it.
 *
 * A hard deadline, counted from the claim (queue wait included) and inside
 * the panel's own wait, settles every claimed job as ready or failed, and
 * frees the analysis slot even when a model ignores its abort signal: the
 * job fails and the slot is freed first, then the model's `reset` (when it
 * has one) runs in the background, with its own timeout, to kill or reset
 * its runtime. Inference never starts after the deadline, even when the
 * evidence refresh finishes late. From claim to settle the job counts as
 * answer activity, so background model work (the tier sniffer) yields to it,
 * and each settled job logs one content-free line of stage timings.
 *
 * Pending polls by the claiming key are rate limited per job (429), never
 * destructive. Unknown, expired (ten minutes from creation) and wrong-install
 * jobs answer 410 `gone`: the endpoint is no oracle for which ids existed.
 * Analyses run one at a time, and after a deadline the next one waits for
 * the model's reset (bounded). Claims of live jobs are rate limited; a claim
 * of an unknown id spends nothing. Nothing here is
 * persisted: an engine restart forgets every job.
 */
import { randomBytes } from 'node:crypto';
import {
  PRIVATE_ANSWER_MAX_REQUEST_BYTES,
  isPanelOrigin,
  privateAnswerInstallId,
  privateAnswerJobId,
  type PrivateAnswerWireStatus,
} from '../../../connect-relay/shared/private-answer.ts';
import {
  PRIVATE_ANSWER_JOB_TTL_MS,
  PRIVATE_MATCH_COUNT_CAP,
  type PrivateAnswerCitation,
  type PrivateAnswerModel,
  type PrivateAnswerModelCall,
  type PrivateAnswerPlaintextV1,
  type PrivateEvidenceItem,
  type PrivateMatchSummary,
} from './private-answer-contract.ts';
import { importPanelPublicKey, padPrivateAnswerPlaintext, sealPrivateAnswer, type SealedPrivateAnswer } from './private-answer-crypto.ts';

/** A content-free local audit event: no job id, no question, no key. */
export type PrivateAnswerAuditEvent = 'claimed_by_other_key' | 'analysis_deadline';

export interface PrivateAnswerJobsOptions {
  /** The private model (the private-model lane's `built_in` analyst), read per use. */
  model: () => PrivateAnswerModel;
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
   * Hard deadline for one analysis, from the claim (queue wait, evidence
   * refresh and model), enforced outside the model.
   */
  analysisTimeoutMs?: number;
  /** Local audit log (default: one line on stderr). */
  audit?: (event: PrivateAnswerAuditEvent) => void;
  /**
   * Answer activity: `begin` when a job is claimed, `end` once it is ready
   * or failed (exactly once each). The worker pauses the tier sniffer and
   * other background model work in between, so the answer never waits on it.
   */
  activity?: { begin(): void; end(): void };
  /** The per-job stage timing line (default: stdout). Counts and milliseconds only. */
  log?: (line: string) => void;
}

/** One analysis's stage costs, logged once it settles. No id, question, evidence or answer. */
interface AnalysisTiming {
  outcome: 'sealed' | 'failed';
  reason: 'deadline' | 'aborted' | 'no_evidence' | 'error';
  queuedMs: number;
  refreshMs?: number;
  matched?: number;
  items?: number;
  unreadable?: number;
  evidenceBytes?: number;
  modelMs?: number;
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

/** `[private-answer] outcome=… queued_ms=… refresh_ms=… …`: stage costs only. */
export function formatAnalysisTiming(timing: AnalysisTiming): string {
  const fields: string[] = [`outcome=${timing.outcome}`];
  if (timing.outcome === 'failed') fields.push(`reason=${timing.reason}`);
  fields.push(`queued_ms=${timing.queuedMs}`);
  if (timing.refreshMs !== undefined) fields.push(`refresh_ms=${timing.refreshMs}`);
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

interface Job {
  readonly id: string;
  readonly expiresAt: number;
  question: string | undefined;
  evidence: readonly PrivateEvidenceItem[] | undefined;
  refresh: PrivateEvidenceRefresh | undefined;
  claimKey?: string;
  pollTokens: number;
  pollRefilledAt: number;
  outcome?: { kind: 'sealed'; sealed: SealedPrivateAnswer } | { kind: 'failed' } | undefined;
  abort?: AbortController;
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
const MAX_EVIDENCE_ITEMS = 50;
const PENDING_RETRY_SECONDS = 2;
/**
 * Inside the panel's own two-minute wait (CHATGPT_PRIVATE_ANSWER_POLL_CAP_MS),
 * so the panel always sees `ready` or `failed`, never gives up on a job the
 * engine is still running.
 */
export const PRIVATE_ANSWER_ANALYSIS_TIMEOUT_MS = 100_000;
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
    if (typeof tier === 'string' && /secret/i.test(tier)) return false;
  }
  return true;
}

export class PrivateAnswerJobs {
  // Assigned in the constructor, not as field initializers: an initializer
  // would make the bundler keep this module in bundles that never use it.
  private readonly jobs: Map<string, Job>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxJobs: number;
  private readonly pollRate: { capacity: number; refillPerSecond: number };
  private readonly resetTimeoutMs: number;
  private readonly claimRate: { capacity: number; refillPerSecond: number };
  private readonly analysisTimeoutMs: number;
  private readonly audit: (event: PrivateAnswerAuditEvent) => void;
  private tokens: number;
  private refilledAt: number;
  private queue: Promise<void>;
  /** A deadline's background reset, bounded by resetTimeoutMs; the next analysis waits for it. */
  private resetting: Promise<void> | undefined;
  private readonly options: PrivateAnswerJobsOptions;

  constructor(options: PrivateAnswerJobsOptions) {
    this.options = options;
    this.jobs = new Map();
    this.queue = Promise.resolve();
    this.resetting = undefined;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PRIVATE_ANSWER_JOB_TTL_MS;
    this.maxJobs = options.maxJobs ?? 200;
    this.pollRate = options.pollRate ?? { capacity: 10, refillPerSecond: 1 };
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.claimRate = options.claimRate ?? { capacity: 60, refillPerSecond: 10 };
    this.analysisTimeoutMs = options.analysisTimeoutMs ?? PRIVATE_ANSWER_ANALYSIS_TIMEOUT_MS;
    this.audit = options.audit ?? defaultAudit;
    this.tokens = this.claimRate.capacity;
    this.refilledAt = this.now();
  }

  get size(): number {
    return this.jobs.size;
  }

  /**
   * A private match: the panel summary, with a job when a private model is
   * ready and this engine has a relay install id. Counts and state only
   * otherwise. `count` is capped at PRIVATE_MATCH_COUNT_CAP. Call it as the
   * tool result is built, so the id is valid only from then on. `refresh`
   * re-reads the evidence at claim time; without it the search-time hits are
   * used, still filtered by isPrivateEligible.
   */
  begin(input: {
    question: string;
    count: number;
    evidence: readonly PrivateEvidenceItem[];
    refresh?: PrivateEvidenceRefresh;
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
    this.jobs.set(id, {
      id,
      expiresAt: this.now() + this.ttlMs,
      question: input.question.slice(0, MAX_QUESTION_CHARS),
      evidence: input.evidence.slice(0, MAX_EVIDENCE_ITEMS),
      refresh: input.refresh,
      pollTokens: this.pollRate.capacity,
      pollRefilledAt: this.now(),
    });
    return { count, panelState: 'ready', jobId: id };
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
      this.startAnalysis(job, panel.key);
    }
    const outcome = job.outcome;
    if (!outcome) {
      if (!this.takePoll(job)) return { status: 429, body: { status: 'rate_limited' }, retryAfterSeconds: PENDING_RETRY_SECONDS };
      return { status: 202, body: { status: 'pending' }, retryAfterSeconds: PENDING_RETRY_SECONDS };
    }
    if (outcome.kind === 'failed') return { status: 200, body: { status: 'failed' } };
    return { status: 200, body: { status: 'ready', v: 1, ...outcome.sealed } };
  }

  /** Drops expired jobs (and aborts their analyses). */
  sweep(at = this.now()): void {
    for (const [id, job] of this.jobs) if (job.expiresAt <= at) this.drop(id);
  }

  private drop(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.abort?.abort();
    job.question = undefined;
    job.evidence = undefined;
    job.refresh = undefined;
    job.outcome = undefined;
    this.jobs.delete(id);
  }

  private startAnalysis(job: Job, panelKey: CryptoKey): void {
    const abort = new AbortController();
    job.abort = abort;
    const claimedAt = this.now();
    const timing: AnalysisTiming = { outcome: 'failed', reason: 'error', queuedMs: 0, calls: [] };
    let running = false;
    let settled = false;
    // Answers come first: the sniffer and other background model work yield
    // from the claim until this job settles, however it settles.
    this.beginActivity();
    const settle = (outcome: Job['outcome'], reason?: AnalysisTiming['reason']) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (this.jobs.get(job.id) === job) job.outcome = outcome;
      timing.outcome = outcome?.kind ?? 'failed';
      if (reason) timing.reason = reason;
      timing.totalMs = this.now() - claimedAt;
      this.endActivity();
      this.logTiming(timing);
    };
    // The deadline runs from the claim, queue wait included, so every
    // claimed job is ready or failed within analysisTimeoutMs whatever the
    // queue, the evidence refresh or the model do.
    const deadlineTimer = setTimeout(() => {
      if (settled) return;
      this.audit('analysis_deadline');
      // Fail the job and free the slot first; a model that was running is
      // reset in the background with its own timeout, so a hung reset
      // blocks nothing.
      const wasRunning = running;
      settle({ kind: 'failed' }, 'deadline');
      abort.abort();
      if (wasRunning) this.resetInBackground();
    }, this.analysisTimeoutMs);
    (deadlineTimer as { unref?: () => void }).unref?.();
    // A job dropped (expired) while it waits in the queue settles at once.
    abort.signal.addEventListener('abort', () => {
      if (!running) settle({ kind: 'failed' }, 'aborted');
    }, { once: true });
    const run = async () => {
      // A model reset after an earlier deadline finishes (or times out)
      // first, so two inferences never overlap and the reset cannot kill
      // this job's run.
      if (this.resetting) await this.resetting;
      timing.queuedMs = this.now() - claimedAt;
      if (settled || abort.signal.aborted || this.jobs.get(job.id) !== job) {
        settle({ kind: 'failed' }, 'aborted');
        return;
      }
      const question = job.question ?? '';
      const cached = job.evidence ?? [];
      const refresh = job.refresh;
      job.question = undefined;
      job.evidence = undefined;
      job.refresh = undefined;
      running = true;
      const work = (async () => {
        const refreshStarted = this.now();
        const found = refresh ? await refresh(abort.signal) : cached;
        if (refresh) timing.refreshMs = this.now() - refreshStarted;
        const evidence = found.filter(isPrivateEligible).slice(0, MAX_EVIDENCE_ITEMS);
        timing.matched = evidence.length;
        // A refresh that finished after the deadline (or after the job was
        // dropped) must not start inference.
        if (abort.signal.aborted) throw new AnalysisStop('aborted');
        if (evidence.length === 0) throw new AnalysisStop('no_evidence');
        const model = this.options.model();
        const modelStarted = this.now();
        try {
          return await model.answerPrivately(question, evidence, abort.signal, {
            evidence: (stats) => {
              timing.items = stats.items;
              timing.unreadable = stats.unreadable;
              timing.evidenceBytes = stats.bytes;
            },
            modelCall: (call) => {
              timing.calls.push(call);
            },
          });
        } finally {
          timing.modelMs = this.now() - modelStarted;
        }
      })();
      work.catch(() => undefined);
      // Bounded by the deadline: the queue moves on when it fires, even if
      // the model ignores its abort signal.
      const stopped = new Promise<void>((resolve) => {
        if (abort.signal.aborted) resolve();
        abort.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      try {
        const result = await Promise.race([work, stopped]);
        if (settled || abort.signal.aborted || result === undefined) {
          settle({ kind: 'failed' }, 'aborted');
          return;
        }
        const sealed = await sealPrivateAnswer(job.id, panelKey, padPrivateAnswerPlaintext(JSON.stringify(plaintextOf(result))));
        settle({ kind: 'sealed', sealed });
      } catch (error) {
        settle({ kind: 'failed' }, error instanceof AnalysisStop ? error.reason : 'error');
      } finally {
        running = false;
      }
    };
    this.queue = this.queue.then(run, run).catch(() => {
      settle({ kind: 'failed' }, 'error');
    });
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

  private takeToken(): boolean {
    const at = this.now();
    this.tokens = Math.min(this.claimRate.capacity, this.tokens + ((at - this.refilledAt) / 1000) * this.claimRate.refillPerSecond);
    this.refilledAt = at;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
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
  const citations: PrivateAnswerCitation[] = [];
  for (const value of Array.isArray(result.citations) ? result.citations : []) {
    if (citations.length >= MAX_CITATIONS) break;
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    const citation: PrivateAnswerCitation = {};
    const title = clean(record.title, MAX_CITATION_TEXT);
    const source = clean(record.source, MAX_CITATION_TEXT);
    const date = clean(record.date, 32);
    if (title) citation.title = title;
    if (source) citation.source = source;
    if (date) citation.date = date;
    if (Object.keys(citation).length > 0) citations.push(citation);
  }
  const unanswered: string[] = [];
  for (const value of Array.isArray(result.unanswered) ? result.unanswered : []) {
    if (unanswered.length >= MAX_UNANSWERED) break;
    const line = clean(value, MAX_CITATION_TEXT);
    if (line) unanswered.push(line);
  }
  return {
    v: 1,
    answer: (typeof result.answer === 'string' ? result.answer : '').replace(UNSAFE_CHARS, '').slice(0, MAX_ANSWER_CHARS),
    citations,
    ...(unanswered.length > 0 ? { unanswered } : {}),
  };
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
    const jobId = url.search ? undefined : privateAnswerJobId(url.pathname);
    if (!options.isRelayed(request) || !jobId) return reply({ status: 404, body: { status: 'gone' } });
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
    return reply(await options.jobs.claim(jobId, record.publicKey));
  };
}

function reply(claim: ClaimResponse, extra: Record<string, string> = {}): Response {
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
