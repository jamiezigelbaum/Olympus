/**
 * Private question jobs: one sealed question from the panel, one sealed
 * outcome back (private-question-contract.ts). The job id shares the
 * private answer job's shape, so the relay routes it by install exactly as
 * it routes a private answer; the private answer HTTP handler asks this
 * registry first (private-answer-jobs.ts, createPrivateAnswerHandler).
 *
 * Life of a job: `begin` (the tool call; the engine's key pair is made here)
 * → `ask` (the panel's sealed question; the first panel key claims the job;
 * the ask lane runs in the background) → `collect` (pending until the ask
 * ends, then the sealed outcome, again and again for the claiming key until
 * expiry) → sweep. Nothing here reads the daily cap or the settings: the ask
 * lane does (consult-ask.ts), and its refusal comes back sealed like an
 * answer.
 */
import { randomBytes } from 'node:crypto';
import type { ConsultAskResult } from '../../core/consult-ask.ts';
import { privateAnswerInstallId } from '../../../connect-relay/shared/private-answer.ts';
import {
  generateEngineKeyPair,
  importPanelPublicKey,
  openPrivateQuestion,
  padPrivateAnswerPlaintext,
  sealPrivateAnswer,
  type SealedPrivateAnswer,
} from './private-answer-crypto.ts';
import type { ClaimResponse } from './private-answer-jobs.ts';
import { chatgptZkapiRefusal, chatgptZkapiRouteLabel } from './zkapi-copy.ts';
import {
  PRIVATE_QUESTION_JOB_TTL_MS,
  PRIVATE_QUESTION_MAX_CHARS,
  type PrivateQuestionCleanup,
  type PrivateQuestionLevel,
  type PrivateQuestionMetaV1,
  type PrivateQuestionPlaintextV1,
  type PrivateQuestionResultV1,
} from './private-question-contract.ts';

export type PrivateQuestionChoice = Pick<PrivateQuestionMetaV1, 'level' | 'cleanup' | 'customInstruction'>;

export interface PrivateQuestionAskInput {
  readonly question: string;
  readonly level: PrivateQuestionLevel;
  readonly cleanup?: PrivateQuestionCleanup;
  readonly signal: AbortSignal;
}

export interface PrivateQuestionJobsOptions {
  /** This install's id (the relay routes the panel's requests by it); undefined means no job can be opened. */
  readonly installId: () => string | undefined;
  /** The ask lane (consult-ask.ts askAnonymously, placed as an OpenAI-hosted caller). */
  readonly ask: (input: PrivateQuestionAskInput) => Promise<ConsultAskResult>;
  /**
   * The panel's default choice (the dashboard's saved level and Standard
   * preparation), read by the composition root: this module stays off the
   * settings file (test/consult-settings.test.ts holds who may read it).
   */
  readonly choice: () => PrivateQuestionChoice;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxJobs?: number;
}

const LEVELS: readonly PrivateQuestionLevel[] = ['strict', 'standard'];
const CLEANUPS: readonly PrivateQuestionCleanup[] = ['as_written', 'light_cleanup', 'custom'];
const PENDING_RETRY_SECONDS = 5;
const WAITING_RETRY_SECONDS = 2;
const POLL_CAPACITY = 12;
const POLL_REFILL_PER_SECOND = 0.5;
const MAX_JOBS = 8;

interface Job {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly enginePrivateKey: CryptoKey;
  readonly askKey: string;
  /** The panel key that asked (base64url raw); set by the first `ask`. */
  claimKey?: string;
  panelKey?: CryptoKey;
  state: 'open' | 'working' | 'done';
  sealed?: SealedPrivateAnswer;
  readonly abort: AbortController;
  pollTokens: number;
  pollRefilledAt: number;
}

function gone(): ClaimResponse {
  return { status: 410, body: { status: 'gone' } };
}

function invalid(): ClaimResponse {
  return { status: 400, body: { status: 'invalid' } };
}

export class PrivateQuestionJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxJobs: number;

  constructor(private readonly options: PrivateQuestionJobsOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PRIVATE_QUESTION_JOB_TTL_MS;
    this.maxJobs = options.maxJobs ?? MAX_JOBS;
  }

  /** Opens a job for the panel; undefined when this install has no id yet (not linked to the relay). */
  async begin(): Promise<PrivateQuestionMetaV1 | undefined> {
    const installId = this.options.installId();
    if (!installId) return undefined;
    this.sweep();
    // Over the cap, the oldest job that is not running is dropped; a job whose ask was dispatched (possibly paid for) is
    // never evicted, so the panel that asked it still collects its outcome (Codex review of PR #227). When every retained
    // job is running the map grows past the cap until one settles or expires.
    while (this.jobs.size >= this.maxJobs) {
      const idle = [...this.jobs.values()].find((job) => job.state !== 'working');
      if (!idle) break;
      this.drop(idle.id);
    }
    const engine = await generateEngineKeyPair();
    const at = this.now();
    const job: Job = {
      id: `oly2p.${installId}.${randomBytes(32).toString('base64url')}`,
      createdAt: at,
      expiresAt: at + this.ttlMs,
      enginePrivateKey: engine.privateKey,
      askKey: engine.publicKey,
      state: 'open',
      abort: new AbortController(),
      pollTokens: POLL_CAPACITY,
      pollRefilledAt: at,
    };
    this.jobs.set(job.id, job);
    const choice = this.choice();
    return { v: 1, jobId: job.id, askKey: job.askKey, ...choice, maxChars: PRIVATE_QUESTION_MAX_CHARS };
  }

  /** Whether `jobId` is one of these jobs (live or not): the handler routes its collection here. */
  has(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  /** The panel's sealed question. 202 once the ask runs; the panel then collects. */
  async ask(jobId: string, body: Record<string, unknown>): Promise<ClaimResponse> {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (!job || privateAnswerInstallId(jobId) !== this.options.installId()) return gone();
    const panel = await importPanelPublicKey(body.publicKey);
    if (!panel) return invalid();
    if (this.jobs.get(jobId) !== job) return gone();
    if (job.claimKey !== undefined && job.claimKey !== panel.raw) return { status: 409, body: { status: 'claimed' } };
    // The same panel asking again (a retried request): the first ask stands.
    if (job.state !== 'open') return this.outcome(job);
    let text: string;
    try {
      text = await openPrivateQuestion(jobId, job.enginePrivateKey, panel.key, { iv: body.iv, ciphertext: body.ciphertext });
    } catch {
      return invalid();
    }
    const plaintext = parseQuestion(text);
    if (!plaintext) return invalid();
    if (this.jobs.get(jobId) !== job || job.state !== 'open') return this.jobs.get(jobId) === job ? this.outcome(job) : gone();
    job.claimKey = panel.raw;
    job.panelKey = panel.key;
    job.state = 'working';
    void this.run(job, plaintext);
    return { status: 202, body: { status: 'pending' }, retryAfterSeconds: PENDING_RETRY_SECONDS };
  }

  /** The panel's collection: pending while the ask runs, then the sealed outcome. */
  async collect(jobId: string, publicKey: unknown): Promise<ClaimResponse> {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (!job || privateAnswerInstallId(jobId) !== this.options.installId()) return gone();
    const panel = await importPanelPublicKey(publicKey);
    if (!panel) return invalid();
    if (this.jobs.get(jobId) !== job) return gone();
    if (job.claimKey !== undefined && job.claimKey !== panel.raw) return { status: 409, body: { status: 'claimed' } };
    if (!this.takePoll(job)) return { status: 429, body: { status: 'rate_limited' }, retryAfterSeconds: PENDING_RETRY_SECONDS };
    return this.outcome(job);
  }

  /**
   * Ask another, in place: a new job for the panel that asked `jobId`, once
   * its outcome is in (owner request 2026-10-10: the panel opened a new
   * question only by asking ChatGPT for a new panel). The panel proves
   * itself with the key that asked; any other key, a job still running, or
   * one this install never minted gets the same answers as a collection.
   * The new job's meta travels in the clear like the tool result's: the
   * relay sees job ids on every request anyway, and the host never sees
   * this response (it is the panel's own fetch).
   */
  async another(jobId: string, publicKey: unknown): Promise<ClaimResponse> {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (!job || privateAnswerInstallId(jobId) !== this.options.installId()) return gone();
    const panel = await importPanelPublicKey(publicKey);
    if (!panel) return invalid();
    if (this.jobs.get(jobId) !== job) return gone();
    if (job.claimKey === undefined || job.claimKey !== panel.raw) return { status: 409, body: { status: 'claimed' } };
    if (job.state !== 'done') return { status: 409, body: { status: 'pending' } };
    if (!this.takePoll(job)) return { status: 429, body: { status: 'rate_limited' }, retryAfterSeconds: PENDING_RETRY_SECONDS };
    const meta = await this.begin();
    if (!meta) return { status: 503, body: { status: 'mac_offline' }, retryAfterSeconds: 30 };
    return { status: 200, body: { status: 'opened', v: 1, meta } };
  }

  sweep(at = this.now()): void {
    for (const [id, job] of this.jobs) if (job.expiresAt <= at) this.drop(id);
  }

  private outcome(job: Job): ClaimResponse {
    if (job.state === 'open') return { status: 202, body: { status: 'pending' }, retryAfterSeconds: WAITING_RETRY_SECONDS };
    if (job.state === 'working' || !job.sealed) return { status: 202, body: { status: 'pending' }, retryAfterSeconds: PENDING_RETRY_SECONDS };
    return { status: 200, body: { status: 'ready', v: 1, ...job.sealed } };
  }

  private async run(job: Job, plaintext: PrivateQuestionPlaintextV1): Promise<void> {
    let result: PrivateQuestionResultV1;
    try {
      const outcome = await this.options.ask({
        question: plaintext.question,
        level: plaintext.level,
        ...(plaintext.cleanup !== undefined ? { cleanup: plaintext.cleanup } : {}),
        signal: job.abort.signal,
      });
      result = resultOf(outcome);
    } catch {
      result = { v: 1, state: 'refused', code: 'internal_error', message: 'The question could not be asked from this computer.' };
    }
    if (this.jobs.get(job.id) !== job || !job.panelKey) return;
    try {
      job.sealed = await sealPrivateAnswer(job.id, job.panelKey, padPrivateAnswerPlaintext(JSON.stringify(result)));
    } catch {
      // Nothing sealed: the panel keeps seeing pending until the job expires. Never a plaintext outcome.
      return;
    }
    job.state = 'done';
  }

  private drop(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    job.abort.abort();
  }

  private takePoll(job: Job): boolean {
    const at = this.now();
    job.pollTokens = Math.min(POLL_CAPACITY, job.pollTokens + ((at - job.pollRefilledAt) / 1000) * POLL_REFILL_PER_SECOND);
    job.pollRefilledAt = at;
    if (job.pollTokens < 1) return false;
    job.pollTokens -= 1;
    return true;
  }

  /** The composition root's choice; an unreadable one falls back to Standard, lightly cleaned up (the dashboard default). */
  private choice(): PrivateQuestionChoice {
    try {
      const choice = this.options.choice();
      const level: PrivateQuestionLevel = choice.level === 'strict' ? 'strict' : 'standard';
      const cleanup: PrivateQuestionCleanup = (CLEANUPS as readonly string[]).includes(choice.cleanup) ? choice.cleanup : 'as_written';
      return { level, cleanup, customInstruction: cleanup === 'custom' && choice.customInstruction === true };
    } catch {
      return { level: 'standard', cleanup: 'light_cleanup', customInstruction: false };
    }
  }
}

function parseQuestion(text: string): PrivateQuestionPlaintextV1 | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/\s+$/, ''));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return undefined;
  const question = typeof record.question === 'string' ? record.question.trim() : '';
  if (!question || question.length > PRIVATE_QUESTION_MAX_CHARS || /\u0000/.test(question)) return undefined;
  if (typeof record.level !== 'string' || !(LEVELS as readonly string[]).includes(record.level)) return undefined;
  if (record.cleanup !== undefined && (typeof record.cleanup !== 'string' || !(CLEANUPS as readonly string[]).includes(record.cleanup))) return undefined;
  return {
    v: 1,
    question,
    level: record.level as PrivateQuestionLevel,
    ...(record.cleanup !== undefined ? { cleanup: record.cleanup as PrivateQuestionCleanup } : {}),
  };
}

/** The ask lane's outcome as the panel reads it: an answer, or a refusal in the user's words. */
export function resultOf(outcome: ConsultAskResult): PrivateQuestionResultV1 {
  if (outcome.ok) {
    return {
      v: 1,
      state: 'answered',
      answer: outcome.reply,
      ...(outcome.model !== undefined ? { model: outcome.model } : {}),
      level: outcome.level,
      ...(outcome.cleanup !== undefined ? { cleanup: outcome.cleanup } : {}),
      rewritten: outcome.rewritten,
      ...(outcome.rewritten ? { sent: outcome.sent } : {}),
      route: chatgptZkapiRouteLabel(outcome.route, outcome.networkIdentity),
      networkIdentity: outcome.networkIdentity,
    };
  }
  // The panel is hosted by ChatGPT: refusals read the way zkapi-copy.ts words them there.
  const refusal = chatgptZkapiRefusal(outcome.code, outcome.message, 'daemonCode' in outcome ? outcome.daemonCode : undefined);
  return {
    v: 1,
    state: 'refused',
    code: refusal.code,
    message: refusal.message,
    ...('outcome' in outcome && outcome.outcome !== undefined && refusal.code !== 'balance_run_out' ? { outcome: outcome.outcome } : {}),
    ...('sent' in outcome && outcome.sent !== undefined ? { sent: outcome.sent } : {}),
  };
}
