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
 *    sealed to that key (private-answer-crypto.ts). The same key gets the
 *    same sealed bytes again until the job expires, so a replay of the
 *    panel's request (by anyone who saw it) is harmless and cannot consume
 *    the answer: only the holder of the panel's private key can open it.
 *
 * A hard deadline outside the model call frees the analysis slot even when a
 * model ignores its abort signal: the job fails and the slot is freed first,
 * then the model's `reset` (when it has one) runs in the background, with its
 * own timeout, to kill or reset its runtime. Inference never starts after the
 * deadline, even when the evidence refresh finishes late.
 *
 * Pending polls by the claiming key are rate limited per job (429), never
 * destructive. Unknown, expired (ten minutes from creation) and wrong-install
 * jobs answer 410 `gone`: the endpoint is no oracle for which ids existed.
 * Analyses run one at a time; claims are rate limited. Nothing here is
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
  type PrivateAnswerPlaintextV1,
  type PrivateEvidenceItem,
  type PrivateMatchSummary,
} from './private-answer-contract.ts';
import { importPanelPublicKey, sealPrivateAnswer, type SealedPrivateAnswer } from './private-answer-crypto.ts';

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
  /** Hard deadline for one analysis (evidence refresh plus model), enforced outside the model. */
  analysisTimeoutMs?: number;
  /** Local audit log (default: one line on stderr). */
  audit?: (event: PrivateAnswerAuditEvent) => void;
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
const MAX_CITATION_TEXT = 300;
const MAX_QUESTION_CHARS = 4_000;
const MAX_EVIDENCE_ITEMS = 50;
const PENDING_RETRY_SECONDS = 2;
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
  private readonly options: PrivateAnswerJobsOptions;

  constructor(options: PrivateAnswerJobsOptions) {
    this.options = options;
    this.jobs = new Map();
    this.queue = Promise.resolve();
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PRIVATE_ANSWER_JOB_TTL_MS;
    this.maxJobs = options.maxJobs ?? 200;
    this.pollRate = options.pollRate ?? { capacity: 10, refillPerSecond: 1 };
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.claimRate = options.claimRate ?? { capacity: 60, refillPerSecond: 10 };
    this.analysisTimeoutMs = options.analysisTimeoutMs ?? 5 * 60_000;
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
    if (!this.takeToken()) return { status: 429, body: { status: 'rate_limited' }, retryAfterSeconds: 5 };
    this.sweep();
    const job = this.jobs.get(jobId);
    // Wrong install, unknown or expired: one answer for all.
    if (!job || privateAnswerInstallId(jobId) !== this.options.installId()) return gone();
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
    this.queue = this.queue.then(async () => {
      if (abort.signal.aborted || this.jobs.get(job.id) !== job) return;
      const question = job.question ?? '';
      const cached = job.evidence ?? [];
      const refresh = job.refresh;
      job.question = undefined;
      job.evidence = undefined;
      job.refresh = undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => resolve('deadline'), this.analysisTimeoutMs);
        (timer as { unref?: () => void }).unref?.();
      });
      const work = (async () => {
        const evidence = (refresh ? await refresh(abort.signal) : cached).filter(isPrivateEligible).slice(0, MAX_EVIDENCE_ITEMS);
        // A refresh that finished after the deadline (or after the job was
        // dropped) must not start inference.
        if (abort.signal.aborted) throw new Error('aborted');
        if (evidence.length === 0) throw new Error('no private evidence');
        const model = this.options.model();
        const result = await model.answerPrivately(question, evidence, abort.signal);
        return sealPrivateAnswer(job.id, panelKey, JSON.stringify(plaintextOf(result)));
      })();
      work.catch(() => undefined);
      try {
        const settled = await Promise.race([work, deadline]);
        if (settled === 'deadline') {
          abort.abort();
          this.audit('analysis_deadline');
          // Fail the job and free the slot first; the reset runs in the
          // background with its own timeout, so a hung reset blocks nothing.
          this.resetInBackground();
          throw new Error('deadline');
        }
        if (abort.signal.aborted) throw new Error('aborted');
        job.outcome = { kind: 'sealed', sealed: settled };
      } catch {
        if (this.jobs.get(job.id) === job) job.outcome = { kind: 'failed' };
      } finally {
        clearTimeout(timer);
      }
    });
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
    void Promise.race([reset.catch(() => undefined), timeout]).finally(() => clearTimeout(timer));
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
export function plaintextOf(result: { answer: unknown; citations?: unknown }): PrivateAnswerPlaintextV1 {
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
  return { v: 1, answer: (typeof result.answer === 'string' ? result.answer : '').replace(UNSAFE_CHARS, '').slice(0, MAX_ANSWER_CHARS), citations };
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
