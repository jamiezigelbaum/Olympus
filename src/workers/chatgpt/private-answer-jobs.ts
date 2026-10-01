/**
 * One-time private-answer jobs and the engine's `/private/<id>` endpoint.
 *
 * A ChatGPT answer whose question matches Private items creates a job here
 * (when a private model is ready). ChatGPT gets only the job id and the count,
 * in the tool result's widget-only `_meta`. The private answer panel collects
 * the answer itself, directly from the relay:
 *
 * 1. It POSTs an ephemeral ECDH public key. The first key to arrive claims
 *    the job; another key gets 409 `claimed` (and the owner's panel shows that
 *    someone else opened it).
 * 2. Claiming starts the private model on the Private evidence the search
 *    found (never Secret: Secrets are not in any searchable corpus). Until it
 *    finishes, the same key gets 202 `pending` with Retry-After.
 * 3. When it is done, the same key gets 200 `ready` with the answer sealed to
 *    that key (private-answer-crypto.ts), once. The job is deleted.
 *
 * Unknown, expired (ten minutes from creation), collected, failed-and-reported
 * and over-polled jobs all answer 410 `gone`: the endpoint is no oracle for
 * which ids existed. Analyses run one at a time; claims are rate limited.
 * Nothing here is persisted: an engine restart forgets every job.
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
import { importPanelPublicKey, sealPrivateAnswer } from './private-answer-crypto.ts';

export interface PrivateAnswerJobsOptions {
  /** The private model (the private-model lane's `built_in` analyst), read per use. */
  model: () => PrivateAnswerModel;
  /** This engine's relay install id; no job is created without one. */
  installId: () => string | undefined;
  now?: () => number;
  ttlMs?: number;
  /** Live jobs at once; the oldest is dropped beyond this. */
  maxJobs?: number;
  /** Claims (POSTs) one job answers before it is dropped. */
  maxClaimsPerJob?: number;
  /** Claims across all jobs: burst and refill per second. */
  claimRate?: { capacity: number; refillPerSecond: number };
  /** Longest one private analysis may take. */
  analysisTimeoutMs?: number;
}

interface Job {
  readonly id: string;
  readonly expiresAt: number;
  question: string | undefined;
  evidence: readonly PrivateEvidenceItem[] | undefined;
  claimKey?: string;
  panelKey?: CryptoKey;
  claims: number;
  outcome?: { kind: 'answered'; plaintext: string } | { kind: 'failed' };
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

export class PrivateAnswerJobs {
  // Assigned in the constructor, not as field initializers: an initializer
  // would make the bundler keep this module in bundles that never use it.
  private readonly jobs: Map<string, Job>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxJobs: number;
  private readonly maxClaimsPerJob: number;
  private readonly claimRate: { capacity: number; refillPerSecond: number };
  private readonly analysisTimeoutMs: number;
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
    this.maxClaimsPerJob = options.maxClaimsPerJob ?? 400;
    this.claimRate = options.claimRate ?? { capacity: 60, refillPerSecond: 10 };
    this.analysisTimeoutMs = options.analysisTimeoutMs ?? 5 * 60_000;
    this.tokens = this.claimRate.capacity;
    this.refilledAt = this.now();
  }

  get size(): number {
    return this.jobs.size;
  }

  /**
   * A private match: the panel summary, with a job when a private model is
   * ready and this engine has a relay install id. Counts and state only
   * otherwise. `count` is capped at PRIVATE_MATCH_COUNT_CAP.
   */
  begin(input: { question: string; count: number; evidence: readonly PrivateEvidenceItem[] }): PrivateMatchSummary & { jobId?: string } {
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
      claims: 0,
    });
    return { count, panelState: 'ready', jobId: id };
  }

  /** One panel POST: claim, poll, or collect. */
  async claim(jobId: string, publicKey: unknown): Promise<ClaimResponse> {
    if (!this.takeToken()) return { status: 429, body: { status: 'rate_limited' }, retryAfterSeconds: 5 };
    this.sweep();
    const job = this.jobs.get(jobId);
    // Wrong install, unknown, expired or collected: one answer for all.
    if (!job || privateAnswerInstallId(jobId) !== this.options.installId()) return gone();
    const panel = await importPanelPublicKey(publicKey);
    if (!panel) return { status: 400, body: { status: 'invalid' } };
    // The job may have gone while the key was imported.
    if (this.jobs.get(jobId) !== job) return gone();
    if (job.claimKey !== undefined && job.claimKey !== panel.raw) return { status: 409, body: { status: 'claimed' } };
    job.claims += 1;
    if (job.claims > this.maxClaimsPerJob) {
      this.drop(jobId);
      return gone();
    }
    if (job.claimKey === undefined) {
      job.claimKey = panel.raw;
      job.panelKey = panel.key;
      this.startAnalysis(job);
    }
    const outcome = job.outcome;
    if (!outcome) return { status: 202, body: { status: 'pending' }, retryAfterSeconds: PENDING_RETRY_SECONDS };
    this.drop(jobId);
    if (outcome.kind === 'failed') return { status: 200, body: { status: 'failed' } };
    const sealed = await sealPrivateAnswer(jobId, job.panelKey!, outcome.plaintext);
    return { status: 200, body: { status: 'ready', v: 1, ...sealed } };
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
    this.jobs.delete(id);
  }

  private startAnalysis(job: Job): void {
    const abort = new AbortController();
    job.abort = abort;
    this.queue = this.queue.then(async () => {
      if (abort.signal.aborted || this.jobs.get(job.id) !== job) return;
      const question = job.question ?? '';
      const evidence = job.evidence ?? [];
      job.question = undefined;
      job.evidence = undefined;
      const timer = setTimeout(() => abort.abort(), this.analysisTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      try {
        const result = await this.options.model().answerPrivately(question, evidence, abort.signal);
        if (abort.signal.aborted) throw new Error('aborted');
        job.outcome = { kind: 'answered', plaintext: JSON.stringify(plaintextOf(result)) };
      } catch {
        job.outcome = { kind: 'failed' };
      } finally {
        clearTimeout(timer);
      }
    });
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
