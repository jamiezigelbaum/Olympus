/**
 * Hand-off for slow `source_answer` calls on surfaces whose clients cut tool
 * calls short (hosted agents: Claude documents about 240 s per tool call).
 *
 * The common case stays one call: `source_answer` waits for the answer up to a
 * hand-off threshold (default 200 s) and returns it exactly as before. Past
 * the threshold it returns a "still working" result carrying a job id, and the
 * answer keeps running in the background; `source_answer_result(job_id)`
 * returns it once it is done.
 *
 * Transport and orchestration only. The work a job runs is the same
 * `ctx.email.sourceAnswer` call, so the value a job stores is the answer the
 * release gate already released (and the client already parsed), and a failed
 * job rethrows the very error the call would have thrown. Nothing here reads,
 * builds or widens an answer.
 *
 * State is in memory, in the process that serves the surface (the worker for
 * remote agents; `olympus serve` for stdio MCP). That is deliberate: the
 * analyst work a job waits on dies with that process anyway, so a persisted
 * job could only ever report "lost" after a restart, and persisting results
 * would add an at-rest copy of released answers that data export and delete
 * would then have to cover. After a restart a job id is simply unknown, and
 * the caller asks again.
 */
import { randomBytes } from 'node:crypto';
import { OperationError, sourceAnswerJobNotFound } from './operation-error.ts';
import type { OperationCaller } from './operation-caller.ts';

export const SOURCE_ANSWER_HANDOFF_DEFAULT_MS = 200_000;
/** Kept below Claude's documented ~240 s per-tool-call limit. */
export const SOURCE_ANSWER_HANDOFF_MAX_MS = 230_000;
export const SOURCE_ANSWER_HANDOFF_MIN_MS = 1_000;
export const SOURCE_ANSWER_RESULT_WAIT_DEFAULT_MS = 60_000;
export const SOURCE_ANSWER_RESULT_WAIT_MAX_MS = 120_000;
export const SOURCE_ANSWER_JOB_TTL_MS = 15 * 60_000;
/** Backstop on a handed-off job; the answer's own timeout chain normally ends it first. */
export const SOURCE_ANSWER_JOB_DEADLINE_MS = 20 * 60_000;
export const SOURCE_ANSWER_MAX_RUNNING_PER_OWNER = 3;
export const SOURCE_ANSWER_MAX_RUNNING_GLOBAL = 12;
export const SOURCE_ANSWER_MAX_RETAINED_PER_OWNER = 16;

const JOB_ID_PREFIX = 'saj_';
/** 32 random bytes: 256 bits, base64url. */
const JOB_ID_PATTERN = /^saj_[A-Za-z0-9_-]{43}$/;

export interface SourceAnswerJobLimits {
  handoffMs: number;
  resultWaitMs: number;
  ttlMs: number;
  deadlineMs: number;
  maxRunningPerOwner: number;
  maxRunningGlobal: number;
  maxRetainedPerOwner: number;
}

export interface SourceAnswerPending {
  status: 'working';
  job_id: string;
  elapsed_ms: number;
  next_tool: 'source_answer_result';
  message: string;
}

/**
 * What one surface call hands the registry: the registry, whose job this is,
 * and the hooks the surface uses for client cancellation.
 */
export interface SourceAnswerJobScope {
  registry: SourceAnswerJobRegistry;
  /** Binding key: jobs are readable only under the same key. */
  owner: string;
  /** The calling client's cancellation (a remote client disconnecting). */
  clientSignal?: AbortSignal;
  /**
   * Called at hand-off: from then on the client's disconnect no longer cancels
   * this call's worker request. Before hand-off it still does, as today.
   */
  detachFromClient?: () => void;
}

interface JobRecord {
  id: string;
  owner: string;
  startedAt: number;
  finishedAt?: number;
  outcome?: { ok: true; value: unknown } | { ok: false; error: unknown };
  settled: Promise<void>;
  deadline?: ReturnType<typeof setTimeout>;
}

export interface SourceAnswerJobRegistryOptions {
  limits?: Partial<SourceAnswerJobLimits>;
  now?: () => number;
}

export class SourceAnswerJobRegistry {
  readonly limits: SourceAnswerJobLimits;
  private readonly now: () => number;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly running = new Map<string, number>();
  private runningTotal = 0;

  constructor(options: SourceAnswerJobRegistryOptions = {}) {
    this.limits = {
      handoffMs: SOURCE_ANSWER_HANDOFF_DEFAULT_MS,
      resultWaitMs: SOURCE_ANSWER_RESULT_WAIT_DEFAULT_MS,
      ttlMs: SOURCE_ANSWER_JOB_TTL_MS,
      deadlineMs: SOURCE_ANSWER_JOB_DEADLINE_MS,
      maxRunningPerOwner: SOURCE_ANSWER_MAX_RUNNING_PER_OWNER,
      maxRunningGlobal: SOURCE_ANSWER_MAX_RUNNING_GLOBAL,
      maxRetainedPerOwner: SOURCE_ANSWER_MAX_RETAINED_PER_OWNER,
      ...options.limits,
    };
    this.now = options.now ?? Date.now;
  }

  /**
   * Runs one answer. Returns its result when it settles within the hand-off
   * threshold (or rethrows its error), exactly as a direct call would;
   * otherwise returns a pending handle and lets the work continue.
   *
   * `work` receives the signal that ends it: the client's disconnect before
   * hand-off (through the surface's own wiring), the job deadline after.
   */
  async run<T>(scope: SourceAnswerJobScope, work: (signal: AbortSignal) => Promise<T>): Promise<T | SourceAnswerPending> {
    this.sweep();
    this.admit(scope.owner);
    const startedAt = this.now();
    const controller = new AbortController();
    this.running.set(scope.owner, (this.running.get(scope.owner) ?? 0) + 1);
    this.runningTotal += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = (this.running.get(scope.owner) ?? 1) - 1;
      if (count <= 0) this.running.delete(scope.owner);
      else this.running.set(scope.owner, count);
      this.runningTotal -= 1;
    };

    let pending: Promise<T>;
    try {
      pending = work(controller.signal);
    } catch (error) {
      release();
      throw error;
    }
    const outcome = pending.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const handoff = new Promise<'handoff'>((resolve) => {
      timer = setTimeout(() => resolve('handoff'), this.limits.handoffMs);
    });
    const first = await Promise.race([outcome, handoff]);
    clearTimeout(timer);
    if (first !== 'handoff') {
      release();
      if (first.ok) return first.value;
      throw first.error;
    }

    // Hand-off. The client may now go away without cancelling the work; the
    // job's own deadline is what ends it from here.
    scope.detachFromClient?.();
    const job: JobRecord = {
      id: newJobId(),
      owner: scope.owner,
      startedAt,
      settled: Promise.resolve(),
    };
    job.deadline = setTimeout(() => {
      controller.abort(new Error('source_answer job deadline reached'));
    }, Math.max(0, this.limits.deadlineMs - (this.now() - startedAt)));
    job.deadline.unref?.();
    job.settled = outcome.then((result) => {
      clearTimeout(job.deadline);
      job.outcome = result;
      job.finishedAt = this.now();
      release();
    });
    this.jobs.set(job.id, job);
    this.evictRetained(scope.owner);
    return pendingResult(job.id, this.now() - startedAt, this.limits.resultWaitMs);
  }

  /**
   * The finished answer (or its error, rethrown), or a pending handle after
   * waiting up to the result wait. An unknown, expired, or another owner's job
   * id is one indistinguishable refusal.
   */
  async result(owner: string, jobId: unknown, signal?: AbortSignal): Promise<unknown> {
    this.sweep();
    const job = typeof jobId === 'string' && JOB_ID_PATTERN.test(jobId) ? this.jobs.get(jobId) : undefined;
    if (!job || job.owner !== owner) throw sourceAnswerJobNotFound();
    if (!job.outcome && this.limits.resultWaitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const stop = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.limits.resultWaitMs);
        if (signal) {
          onAbort = () => resolve();
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      await Promise.race([job.settled, stop]);
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
    if (!job.outcome) return pendingResult(job.id, this.now() - job.startedAt, this.limits.resultWaitMs);
    if (job.outcome.ok) return job.outcome.value;
    throw job.outcome.error;
  }

  /** Running calls (before and after hand-off) and retained jobs, for tests and status. */
  stats(): { running: number; jobs: number } {
    this.sweep();
    return { running: this.runningTotal, jobs: this.jobs.size };
  }

  private admit(owner: string): void {
    if ((this.running.get(owner) ?? 0) >= this.limits.maxRunningPerOwner
      || this.runningTotal >= this.limits.maxRunningGlobal) {
      throw new OperationError(
        'source_answer_busy',
        'Too many Olympus answers are already in progress for this connection.',
        'Wait for the answers in progress (call source_answer_result with their job ids) before asking another question.',
      );
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== undefined && now - job.finishedAt >= this.limits.ttlMs) this.jobs.delete(id);
    }
  }

  /** Oldest finished jobs go first; running jobs are bounded by admission instead. */
  private evictRetained(owner: string): void {
    const finished = [...this.jobs.values()]
      .filter((job) => job.owner === owner && job.finishedAt !== undefined)
      .sort((a, b) => a.finishedAt! - b.finishedAt!);
    const owned = [...this.jobs.values()].filter((job) => job.owner === owner).length;
    let excess = owned - this.limits.maxRetainedPerOwner;
    for (const job of finished) {
      if (excess <= 0) break;
      this.jobs.delete(job.id);
      excess -= 1;
    }
  }
}

/**
 * The binding key for a caller, or undefined when the surface cannot bind a
 * job to its caller (then no hand-off happens). A remote caller is its
 * owner-approved connection; a stdio MCP server serves exactly one client, so
 * the process-local registry is already per client.
 */
export function sourceAnswerJobOwner(caller: OperationCaller | undefined): string | undefined {
  if (!caller) return undefined;
  if (caller.surface === 'remote') return caller.connectionId ? `remote:${caller.connectionId}` : undefined;
  if (caller.surface === 'mcp') return 'mcp:stdio';
  return undefined;
}

/**
 * Reads the two operator knobs. `OLYMPUS_SOURCE_ANSWER_HANDOFF_MS` sets the
 * threshold (clamped to 1 s–230 s, below Claude's per-call limit);
 * `OLYMPUS_SOURCE_ANSWER_RESULT_WAIT_MS` how long one result call waits
 * (0–120 s, and never past the threshold).
 */
export function sourceAnswerJobLimitsFromEnv(env: NodeJS.ProcessEnv): Partial<SourceAnswerJobLimits> {
  const handoffMs = clampedInteger(env.OLYMPUS_SOURCE_ANSWER_HANDOFF_MS, SOURCE_ANSWER_HANDOFF_MIN_MS, SOURCE_ANSWER_HANDOFF_MAX_MS)
    ?? SOURCE_ANSWER_HANDOFF_DEFAULT_MS;
  const resultWaitMs = Math.min(
    clampedInteger(env.OLYMPUS_SOURCE_ANSWER_RESULT_WAIT_MS, 0, SOURCE_ANSWER_RESULT_WAIT_MAX_MS) ?? SOURCE_ANSWER_RESULT_WAIT_DEFAULT_MS,
    handoffMs,
  );
  return { handoffMs, resultWaitMs };
}

export function isSourceAnswerPending(value: unknown): value is SourceAnswerPending {
  return typeof value === 'object' && value !== null && (value as { status?: unknown }).status === 'working'
    && typeof (value as { job_id?: unknown }).job_id === 'string';
}

function pendingResult(jobId: string, elapsedMs: number, resultWaitMs: number): SourceAnswerPending {
  const wait = Math.round(resultWaitMs / 1000);
  return {
    status: 'working',
    job_id: jobId,
    elapsed_ms: elapsedMs,
    next_tool: 'source_answer_result',
    message: 'Olympus is still preparing this answer and it keeps running. '
      + `Call source_answer_result with this job_id to get it${wait > 0 ? ` (each call waits up to ${wait} s)` : ''}; `
      + 'repeat while it says working. Do not ask the question again.',
  };
}

function newJobId(): string {
  return `${JOB_ID_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function clampedInteger(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
