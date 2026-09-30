/**
 * Hand-off for slow `source_answer` calls on surfaces whose clients cut tool
 * calls short (hosted agents: Claude documents about 240 s per tool call).
 *
 * The common case stays one call: `source_answer` waits for the answer up to a
 * per-surface hand-off threshold (200 s remote, 45 s local stdio MCP) and
 * returns it exactly as before. Past
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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OperationError, sourceAnswerJobNotFound } from './operation-error.ts';
import type { OperationCaller } from './operation-caller.ts';

export const SOURCE_ANSWER_HANDOFF_DEFAULT_MS = 200_000;
/**
 * The local stdio MCP default (`olympus serve`, used by Codex and Claude
 * Code): under Codex's 60 s default MCP tool timeout.
 */
export const SOURCE_ANSWER_STDIO_HANDOFF_DEFAULT_MS = 45_000;
/** Kept below Claude's documented ~240 s per-tool-call limit. */
export const SOURCE_ANSWER_HANDOFF_MAX_MS = 230_000;
export const SOURCE_ANSWER_HANDOFF_MIN_MS = 1_000;
export const SOURCE_ANSWER_RESULT_WAIT_DEFAULT_MS = 60_000;
export const SOURCE_ANSWER_RESULT_WAIT_MAX_MS = 120_000;
export const SOURCE_ANSWER_JOB_TTL_MS = 15 * 60_000;
/** Backstop on a handed-off job; the answer's own timeout chain normally ends it first. */
export const SOURCE_ANSWER_JOB_DEADLINE_MS = 20 * 60_000;
/**
 * Sized to the analyst, not to the HTTP server: the local analyst is a
 * single-lane model, and remote answers share that lane with the owner's own
 * native answers (there is no priority lane). Two running remote answers is
 * the most that can ever queue ahead of an owner's question.
 * `OLYMPUS_SOURCE_ANSWER_MAX_RUNNING` raises it for a multi-lane analyst.
 */
export const SOURCE_ANSWER_MAX_RUNNING_GLOBAL = 2;
export const SOURCE_ANSWER_MAX_RUNNING_GLOBAL_CEILING = 16;
export const SOURCE_ANSWER_MAX_RUNNING_PER_OWNER = 2;
export const SOURCE_ANSWER_MAX_RETAINED_PER_OWNER = 16;
/** A stored answer's serialized size cap. */
export const SOURCE_ANSWER_MAX_RESULT_BYTES = 2 * 1024 * 1024;

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
  maxResultBytes: number;
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
  /** Resolves when the job finishes: its work settles, its deadline passes, or it is dropped. */
  done: Promise<void>;
  /** Records the outcome once, frees the running slot, and wakes result waiters. */
  finish(outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): void;
  abort(reason: Error): void;
  deadline?: ReturnType<typeof setTimeout>;
}

export interface SourceAnswerJobRegistryOptions {
  limits?: Partial<SourceAnswerJobLimits>;
  now?: () => number;
  /**
   * Whether an owner's approval has been withdrawn (a revoked connection).
   * Checked on every sweep; a revoked owner's jobs are aborted and dropped.
   */
  isOwnerRevoked?: (owner: string) => boolean;
}

export class SourceAnswerJobRegistry {
  readonly limits: SourceAnswerJobLimits;
  private readonly now: () => number;
  private readonly isOwnerRevoked: ((owner: string) => boolean) | undefined;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly running = new Map<string, number>();
  private runningTotal = 0;

  constructor(options: SourceAnswerJobRegistryOptions = {}) {
    const limits = {
      handoffMs: SOURCE_ANSWER_HANDOFF_DEFAULT_MS,
      resultWaitMs: SOURCE_ANSWER_RESULT_WAIT_DEFAULT_MS,
      ttlMs: SOURCE_ANSWER_JOB_TTL_MS,
      deadlineMs: SOURCE_ANSWER_JOB_DEADLINE_MS,
      maxRunningPerOwner: SOURCE_ANSWER_MAX_RUNNING_PER_OWNER,
      maxRunningGlobal: SOURCE_ANSWER_MAX_RUNNING_GLOBAL,
      maxRetainedPerOwner: SOURCE_ANSWER_MAX_RETAINED_PER_OWNER,
      maxResultBytes: SOURCE_ANSWER_MAX_RESULT_BYTES,
      ...options.limits,
    };
    // One connection can never hold more than the whole allowance.
    limits.maxRunningPerOwner = Math.min(limits.maxRunningPerOwner, limits.maxRunningGlobal);
    this.limits = limits;
    this.now = options.now ?? Date.now;
    this.isOwnerRevoked = options.isOwnerRevoked;
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
    const release = this.occupy(scope.owner);

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
    let wake!: () => void;
    const job: JobRecord = {
      id: newJobId(),
      owner: scope.owner,
      startedAt,
      done: new Promise<void>((resolve) => { wake = resolve; }),
      finish: (result) => {
        if (job.outcome) return;
        clearTimeout(job.deadline);
        job.outcome = this.bounded(result);
        job.finishedAt = this.now();
        release();
        wake();
      },
      abort: (reason) => controller.abort(reason),
    };
    // The deadline frees the slot and records its own error at once; it does
    // not wait for the work to notice the abort, so work that never settles
    // cannot hold a slot past it.
    job.deadline = setTimeout(() => {
      job.abort(callerAbortError('source_answer job deadline reached'));
      job.finish({ ok: false, error: sourceAnswerDeadline(this.limits.deadlineMs) });
    }, Math.max(0, this.limits.deadlineMs - (this.now() - startedAt)));
    job.deadline.unref?.();
    void outcome.then((result) => job.finish(result));
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
    if (!job || !sameOwner(job.owner, owner)) throw sourceAnswerJobNotFound();
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
      await Promise.race([job.done, stop]);
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
    // Dropped while waiting (its connection was revoked).
    if (!this.jobs.has(job.id)) throw sourceAnswerJobNotFound();
    if (!job.outcome) return pendingResult(job.id, this.now() - job.startedAt, this.limits.resultWaitMs);
    if (job.outcome.ok) return job.outcome.value;
    throw job.outcome.error;
  }

  /**
   * Aborts and forgets every job an owner holds (a revoked connection). Its
   * running slots are freed at once.
   */
  dropOwner(owner: string): void {
    for (const [id, job] of this.jobs) {
      if (!sameOwner(job.owner, owner)) continue;
      this.jobs.delete(id);
      job.abort(callerAbortError('source_answer connection revoked'));
      job.finish({ ok: false, error: sourceAnswerJobNotFound() });
    }
  }

  /** Expires finished jobs and drops revoked owners' jobs; also run on a timer by the worker. */
  sweep(): void {
    const now = this.now();
    const owners = new Map<string, boolean>();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== undefined && now - job.finishedAt >= this.limits.ttlMs) {
        this.jobs.delete(id);
        continue;
      }
      if (this.isOwnerRevoked) {
        let revoked = owners.get(job.owner);
        if (revoked === undefined) {
          try {
            revoked = this.isOwnerRevoked(job.owner);
          } catch {
            revoked = false;
          }
          owners.set(job.owner, revoked);
        }
        if (revoked) this.dropOwner(job.owner);
      }
    }
  }

  /** Running calls (before and after hand-off) and retained jobs, for tests and status. */
  stats(): { running: number; jobs: number } {
    this.sweep();
    return { running: this.runningTotal, jobs: this.jobs.size };
  }

  private occupy(owner: string): () => void {
    this.running.set(owner, (this.running.get(owner) ?? 0) + 1);
    this.runningTotal += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.running.get(owner) ?? 1) - 1;
      if (count <= 0) this.running.delete(owner);
      else this.running.set(owner, count);
      this.runningTotal -= 1;
    };
  }

  private admit(owner: string): void {
    if ((this.running.get(owner) ?? 0) >= this.limits.maxRunningPerOwner
      || this.runningTotal >= this.limits.maxRunningGlobal) {
      throw new OperationError(
        'source_answer_busy',
        'Olympus is already answering as many questions as its analyst can take at once.',
        'Wait for the answers in progress (call source_answer_result with their job ids) before asking another question.',
      );
    }
  }

  /** A stored answer larger than the cap is replaced by an error, never truncated. */
  private bounded(result: { ok: true; value: unknown } | { ok: false; error: unknown }) {
    if (!result.ok) return result;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(result.value) ?? '', 'utf8');
    } catch {
      bytes = Number.POSITIVE_INFINITY;
    }
    if (bytes <= this.limits.maxResultBytes) return result;
    return {
      ok: false as const,
      error: new OperationError(
        'source_answer_too_large',
        'The finished answer was too large for Olympus to hold for collection.',
        'Ask a narrower question with source_answer.',
      ),
    };
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

/** Constant-time owner comparison, so a lookup cannot time out another key. */
function sameOwner(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * The abort reason the answer pipeline treats as the caller's cancellation
 * (an AbortError that is not a lane timeout): it ends the analyst route
 * without counting against the lane.
 */
function callerAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function sourceAnswerDeadline(deadlineMs: number): OperationError {
  return new OperationError(
    'source_answer_deadline',
    `The answer did not finish within Olympus's ${Math.round(deadlineMs / 60_000)}-minute limit and was stopped.`,
    'Ask a narrower question, or try again later.',
  );
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

export type SourceAnswerJobSurface = 'remote' | 'stdio';

/**
 * Reads the operator knobs for one surface. The threshold is per surface,
 * because the clients differ: remote agents (worker `/mcp` and OpenAPI) read
 * `OLYMPUS_SOURCE_ANSWER_HANDOFF_MS` (default 200 s, below Claude's ~240 s);
 * local stdio MCP reads `OLYMPUS_SOURCE_ANSWER_STDIO_HANDOFF_MS` (default
 * 45 s, below Codex's 60 s). Both clamp to 1 s–230 s.
 * `OLYMPUS_SOURCE_ANSWER_RESULT_WAIT_MS` sets how long one result call waits
 * (0–120 s, default 60 s, and never past the surface's threshold).
 * `OLYMPUS_SOURCE_ANSWER_MAX_RUNNING` sets how many answers may run at once
 * (1–16, default 2: the analyst's lane count, not the server's).
 */
export function sourceAnswerJobLimitsFromEnv(
  env: NodeJS.ProcessEnv,
  surface: SourceAnswerJobSurface,
): Partial<SourceAnswerJobLimits> {
  const configured = surface === 'stdio' ? env.OLYMPUS_SOURCE_ANSWER_STDIO_HANDOFF_MS : env.OLYMPUS_SOURCE_ANSWER_HANDOFF_MS;
  const handoffMs = clampedInteger(configured, SOURCE_ANSWER_HANDOFF_MIN_MS, SOURCE_ANSWER_HANDOFF_MAX_MS)
    ?? (surface === 'stdio' ? SOURCE_ANSWER_STDIO_HANDOFF_DEFAULT_MS : SOURCE_ANSWER_HANDOFF_DEFAULT_MS);
  const resultWaitMs = Math.min(
    clampedInteger(env.OLYMPUS_SOURCE_ANSWER_RESULT_WAIT_MS, 0, SOURCE_ANSWER_RESULT_WAIT_MAX_MS) ?? SOURCE_ANSWER_RESULT_WAIT_DEFAULT_MS,
    handoffMs,
  );
  const maxRunningGlobal = clampedInteger(env.OLYMPUS_SOURCE_ANSWER_MAX_RUNNING, 1, SOURCE_ANSWER_MAX_RUNNING_GLOBAL_CEILING);
  return { handoffMs, resultWaitMs, ...(maxRunningGlobal !== undefined ? { maxRunningGlobal } : {}) };
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
