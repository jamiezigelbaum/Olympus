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
 *
 * Priority (opt-in, `priority`; docs/design/background-agents.md section E).
 * The worker marks remote agents that are not ChatGPT as background
 * connections. Their answers never start while the owner's own answers are
 * in flight (native, ChatGPT, the private answer panel, the local Private
 * answers page: workers/answer-activity.ts), at most one runs per connection,
 * and together they leave one running slot for the owner's ChatGPT. The rest
 * wait in a small fair queue (round robin across connections, first come
 * first served within one); past its bound a call is refused as busy, with a
 * retry-after (core/remote-result.ts). A background answer that has waited
 * `maxWaitMs` behind the owner's work starts anyway, so none starves. An
 * owner's own call that finds every slot taken while background answers
 * hold some waits ahead of every background call instead of being refused,
 * so even at one slot the owner goes first at each succession. A call whose
 * connection has been revoked never starts: authorization is checked at its
 * turn, and sweeps drop waiting calls as well as handed-off jobs. A
 * queued call's wait counts toward its hand-off, so it hands off exactly as a
 * slow answer does; the client's disconnect before hand-off, the job's
 * deadline and a revoked connection each take it out of the queue. Only when
 * and whether an answer starts changes, never what it says.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OperationError, sourceAnswerJobNotFound } from './operation-error.ts';
import { secretLabelsInText } from './opsec.ts';
import {
  adoptReleaseManifests,
  createReleaseManifestSink,
  currentReleaseManifestSink,
  runWithReleaseManifestSink,
  type ReleaseManifest,
  type ReleaseManifestSink,
} from './release-manifest.ts';
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
/** Waiting background answers: per connection and in all. */
export const SOURCE_ANSWER_MAX_QUEUED_PER_BACKGROUND_OWNER = 2;
export const SOURCE_ANSWER_MAX_QUEUED_BACKGROUND = 8;
/** How long a background answer waits behind the owner's own answers before it starts anyway. */
export const SOURCE_ANSWER_BACKGROUND_MAX_WAIT_MS = 30_000;
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
  /**
   * The job's own release manifests (core/release-manifest.ts), kept with it
   * and handed to the call that collects it. Only a call that opened a sink
   * (the remote surface) gets one; it is never serialized.
   */
  releaseManifests?: ReleaseManifestSink;
}

/** The owner's own answers in flight (workers/answer-activity.ts). */
export interface SourceAnswerInteractiveWork {
  busy(): boolean;
  /** Calls `listener` when the owner's answers in flight drop to none; returns its removal. */
  onIdle(listener: () => void): () => void;
}

export interface SourceAnswerPriorityOptions {
  /** Whether an owner key is a background connection (a remote agent that is not ChatGPT). */
  isBackground(owner: string): boolean;
  /** Without it, background answers wait only for each other and the running limits. */
  interactive?: SourceAnswerInteractiveWork;
  maxQueuedPerOwner?: number;
  maxQueuedTotal?: number;
  maxWaitMs?: number;
}

interface Waiter {
  owner: string;
  /** The owner's own call waiting for a slot background answers hold, or a background call. */
  kind: 'owner' | 'background';
  enqueuedAt: number;
  /** Its place in the shared order of arrivals and starts. */
  tick: number;
  grant(): void;
  /** Takes it out of the queue with `reason`; `wake` false when the caller dispatches itself. */
  cancel(reason: unknown, wake?: boolean): void;
}

interface Priority {
  isBackground(owner: string): boolean;
  interactive: SourceAnswerInteractiveWork | undefined;
  maxQueuedPerOwner: number;
  maxQueuedTotal: number;
  maxWaitMs: number;
  /** Waiting background calls per owner, oldest first. */
  queues: Map<string, Waiter[]>;
  /** The owner's own calls waiting for a slot background answers hold, oldest first: served before any background call. */
  ownerQueue: Waiter[];
  /**
   * When each owner with work here last started an answer, on the same
   * counter as arrivals: an owner's turn comes by the later of the two, so
   * one that just started an answer goes behind every connection already
   * waiting, and no connection waits more than one turn of each other.
   */
  lastServed: Map<string, number>;
  ticks: number;
  queued: number;
  /** Running background answers per owner (granted, not yet released). */
  running: Map<string, number>;
  runningTotal: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface SourceAnswerJobRegistryOptions {
  limits?: Partial<SourceAnswerJobLimits>;
  now?: () => number;
  /**
   * Whether an owner's approval has been withdrawn (a revoked connection).
   * Checked on every sweep; a revoked owner's jobs are aborted and dropped.
   */
  isOwnerRevoked?: (owner: string) => boolean;
  /** Background connections wait behind the owner's own answers; see the module comment. */
  priority?: SourceAnswerPriorityOptions;
}

export class SourceAnswerJobRegistry {
  readonly limits: SourceAnswerJobLimits;
  private readonly now: () => number;
  private readonly isOwnerRevoked: ((owner: string) => boolean) | undefined;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly running = new Map<string, number>();
  private runningTotal = 0;
  private readonly priority: Priority | undefined;

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
    const priority = options.priority;
    this.priority = priority
      ? {
          isBackground: priority.isBackground,
          interactive: priority.interactive,
          maxQueuedPerOwner: Math.max(0, priority.maxQueuedPerOwner ?? SOURCE_ANSWER_MAX_QUEUED_PER_BACKGROUND_OWNER),
          maxQueuedTotal: Math.max(0, priority.maxQueuedTotal ?? SOURCE_ANSWER_MAX_QUEUED_BACKGROUND),
          maxWaitMs: Math.max(0, priority.maxWaitMs ?? SOURCE_ANSWER_BACKGROUND_MAX_WAIT_MS),
          queues: new Map(),
          ownerQueue: [],
          lastServed: new Map(),
          ticks: 0,
          queued: 0,
          running: new Map(),
          runningTotal: 0,
          timer: undefined,
        }
      : undefined;
    priority?.interactive?.onIdle(() => this.dispatch());
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
    const startedAt = this.now();
    const controller = new AbortController();
    const turn = this.priority?.isBackground(scope.owner)
      ? this.enqueue(scope, controller.signal, 'background')
      : this.ownerMustWait(scope.owner) ? this.enqueue(scope, controller.signal, 'owner') : undefined;
    if (!turn) this.admit(scope.owner);
    const release = turn ? turn.release : this.occupy(scope.owner);
    // A caller collecting release manifests gets them for this work alone,
    // whether it returns now or is collected later from the job.
    const callerManifests = currentReleaseManifestSink();
    const jobManifests = callerManifests ? createReleaseManifestSink() : undefined;

    let pending: Promise<T>;
    try {
      const start = turn
        ? () => turn.ready.then(() => work(controller.signal))
        : () => work(controller.signal);
      pending = jobManifests ? runWithReleaseManifestSink(jobManifests, start) : start();
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
      if (callerManifests && jobManifests) adoptReleaseManifests(callerManifests, jobManifests);
      if (first.ok) return first.value;
      throw first.error;
    }

    // Hand-off. The client may now go away without cancelling the work; the
    // job's own deadline is what ends it from here.
    turn?.detach();
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
      ...(jobManifests ? { releaseManifests: jobManifests } : {}),
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
    if (job.outcome.ok) {
      // The collecting call revalidates the answer against its manifests.
      const collecting = currentReleaseManifestSink();
      if (collecting && job.releaseManifests) adoptReleaseManifests(collecting, job.releaseManifests);
      return job.outcome.value;
    }
    throw job.outcome.error;
  }

  /**
   * Resolves once a handed-off job finishes, with its outcome and the job's
   * own release manifests, without collecting it: no result wait, and no
   * manifests handed to the current call. For work that must happen when the
   * job ends whether or not anyone collects it (the remote Private part,
   * core/remote-private-part.ts). Undefined for an unknown, expired or another
   * owner's job; a job that failed, hit its deadline or was dropped resolves
   * as not ok.
   */
  whenFinished(
    owner: string,
    jobId: unknown,
  ): Promise<{ ok: true; value: unknown; releaseManifests: readonly ReleaseManifest[] } | { ok: false }> | undefined {
    const job = typeof jobId === 'string' && JOB_ID_PATTERN.test(jobId) ? this.jobs.get(jobId) : undefined;
    if (!job || !sameOwner(job.owner, owner)) return undefined;
    return job.done.then(() => {
      const outcome = job.outcome;
      return outcome?.ok
        ? { ok: true as const, value: outcome.value, releaseManifests: [...(job.releaseManifests?.manifests ?? [])] }
        : { ok: false as const };
    });
  }

  /**
   * Aborts and forgets every job an owner holds (a revoked connection). Its
   * running slots are freed at once.
   */
  dropOwner(owner: string): void {
    // Its waiting calls all go at once, and only then may anyone else take a turn.
    this.cancelWaiting(owner, callerAbortError('source_answer connection revoked'));
    for (const [id, job] of this.jobs) {
      if (!sameOwner(job.owner, owner)) continue;
      this.jobs.delete(id);
      job.abort(callerAbortError('source_answer connection revoked'));
      job.finish({ ok: false, error: sourceAnswerJobNotFound() });
    }
    this.dispatch();
  }

  /** Expires finished jobs and drops revoked owners' jobs and waiting calls; also run on a timer by the worker. */
  sweep(): void {
    const now = this.now();
    const owners = new Map<string, boolean>();
    const revoked = (owner: string): boolean => {
      let known = owners.get(owner);
      if (known === undefined) {
        try {
          known = this.isOwnerRevoked?.(owner) === true;
        } catch {
          known = false;
        }
        owners.set(owner, known);
      }
      return known;
    };
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== undefined && now - job.finishedAt >= this.limits.ttlMs) {
        this.jobs.delete(id);
        continue;
      }
      if (this.isOwnerRevoked && revoked(job.owner)) this.dropOwner(job.owner);
    }
    const priority = this.priority;
    if (priority && this.isOwnerRevoked) {
      const waiting = new Set([...priority.queues.keys(), ...priority.ownerQueue.map((waiter) => waiter.owner)]);
      for (const owner of waiting) if (revoked(owner)) this.dropOwner(owner);
    }
  }

  /** Running calls (before and after hand-off) and retained jobs, for tests and status. */
  stats(): { running: number; jobs: number } {
    this.sweep();
    return { running: this.runningTotal, jobs: this.jobs.size };
  }

  /** Background calls waiting for their turn (always 0 without `priority`). */
  queued(): number {
    return this.priority?.queued ?? 0;
  }

  /**
   * Whether an owner's own call must wait rather than start or be refused:
   * it is within its own running limit, and the only thing in its way is
   * a full house that background answers share. It then waits ahead of every
   * background call, so at capacity one the owner is served at the next
   * succession instead of being refused while background answers take turns.
   */
  private ownerMustWait(owner: string): boolean {
    const priority = this.priority;
    if (!priority) return false;
    if ((this.running.get(owner) ?? 0) + this.ownerWaiting(owner) >= this.limits.maxRunningPerOwner) return false;
    return priority.ownerQueue.length > 0
      || (this.runningTotal >= this.limits.maxRunningGlobal && priority.runningTotal > 0);
  }

  private ownerWaiting(owner: string): number {
    return this.priority!.ownerQueue.filter((waiter) => waiter.owner === owner).length;
  }

  /**
   * Queues a call, or refuses it as busy past the queue's bounds. `ready`
   * resolves when it may start; `release` frees its turn (or its place in
   * the queue) once; the client's disconnect cancels it until `detach`
   * (hand-off), the job's own signal always does.
   */
  private enqueue(scope: SourceAnswerJobScope, jobSignal: AbortSignal, kind: 'owner' | 'background'): { ready: Promise<void>; release: () => void; detach: () => void } {
    const priority = this.priority!;
    const owner = scope.owner;
    if (kind === 'owner') {
      if (this.ownerWaiting(owner) >= Math.max(1, priority.maxQueuedPerOwner) || priority.queued >= Math.max(1, priority.maxQueuedTotal)) {
        throw sourceAnswerBusy();
      }
    } else {
      const waiting = priority.queues.get(owner)?.length ?? 0;
      if (waiting >= priority.maxQueuedPerOwner || priority.queued >= priority.maxQueuedTotal) {
        // Nothing waits unless it must: a call that can start now is not refused.
        if (waiting > 0 || !this.backgroundMayStart(owner, this.now(), this.now())) throw sourceAnswerBusy();
      }
    }
    let state: 'queued' | 'running' | 'done' = 'queued';
    let detached = false;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const ready = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    // A cancelled turn's rejection is the work's own; never an unhandled one here.
    ready.catch(() => undefined);
    const onClient = () => { if (!detached) waiter.cancel(callerAbortError('source_answer client disconnected')); };
    const onJob = () => waiter.cancel(jobSignal.reason ?? callerAbortError('source_answer job ended'));
    const unlisten = () => {
      scope.clientSignal?.removeEventListener('abort', onClient);
      jobSignal.removeEventListener('abort', onJob);
    };
    const waiter: Waiter = {
      owner,
      kind,
      enqueuedAt: this.now(),
      tick: ++priority.ticks,
      grant: () => {
        if (state !== 'queued') return;
        state = 'running';
        unlisten();
        if (kind === 'background') {
          priority.running.set(owner, (priority.running.get(owner) ?? 0) + 1);
          priority.runningTotal += 1;
          priority.ticks += 1;
          priority.lastServed.set(owner, priority.ticks);
        }
        this.running.set(owner, (this.running.get(owner) ?? 0) + 1);
        this.runningTotal += 1;
        // Counted as running first, so leaving the queue keeps its turn history.
        this.unqueue(waiter);
        resolve();
      },
      cancel: (reason, wake = true) => {
        if (state !== 'queued') return;
        state = 'done';
        unlisten();
        this.unqueue(waiter);
        reject(reason);
        if (wake) this.dispatch();
      },
    };
    if (kind === 'owner') {
      priority.ownerQueue.push(waiter);
    } else {
      const queue = priority.queues.get(owner);
      if (queue) queue.push(waiter);
      else priority.queues.set(owner, [waiter]);
    }
    priority.queued += 1;
    if (scope.clientSignal?.aborted) onClient();
    else scope.clientSignal?.addEventListener('abort', onClient, { once: true });
    if (jobSignal.aborted) onJob();
    else jobSignal.addEventListener('abort', onJob, { once: true });
    this.dispatch();
    const release = () => {
      if (state === 'queued') {
        waiter.cancel(callerAbortError('source_answer released before it started'));
        return;
      }
      if (state !== 'running') return;
      state = 'done';
      if (kind === 'background') {
        const backgroundCount = (priority.running.get(owner) ?? 1) - 1;
        if (backgroundCount <= 0) priority.running.delete(owner);
        else priority.running.set(owner, backgroundCount);
        priority.runningTotal -= 1;
      }
      const count = (this.running.get(owner) ?? 1) - 1;
      if (count <= 0) this.running.delete(owner);
      else this.running.set(owner, count);
      this.runningTotal -= 1;
      if (kind === 'background') this.forgetIdleOwner(owner);
      this.dispatch();
    };
    return { ready, release, detach: () => { detached = true; } };
  }

  private unqueue(waiter: Waiter): void {
    const priority = this.priority!;
    if (waiter.kind === 'owner') {
      const index = priority.ownerQueue.indexOf(waiter);
      if (index < 0) return;
      priority.ownerQueue.splice(index, 1);
      priority.queued -= 1;
      return;
    }
    const queue = priority.queues.get(waiter.owner);
    const index = queue?.indexOf(waiter) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    priority.queued -= 1;
    if (queue.length === 0) {
      priority.queues.delete(waiter.owner);
      this.forgetIdleOwner(waiter.owner);
    }
  }

  /** Takes every waiting call of `owner` out at once, without letting anyone else start in between. */
  private cancelWaiting(owner: string, reason: unknown): void {
    const priority = this.priority;
    if (!priority) return;
    const waiting = [...(priority.queues.get(owner) ?? []), ...priority.ownerQueue.filter((waiter) => waiter.owner === owner)];
    for (const waiter of waiting) waiter.cancel(reason, false);
  }

  /** An owner with nothing waiting or running here keeps no turn history. */
  private forgetIdleOwner(owner: string): void {
    const priority = this.priority!;
    if (!priority.queues.has(owner) && !priority.running.has(owner)) priority.lastServed.delete(owner);
  }

  /**
   * Whether a background call of `owner` that has waited since `enqueuedAt`
   * may start now: no owner's own call is waiting, its connection runs
   * nothing, the background answers leave the owner a slot, there is room at
   * all, and the owner's own answers are not in flight (or it has waited its
   * longest).
   */
  private backgroundMayStart(owner: string, enqueuedAt: number, at: number): boolean {
    const priority = this.priority!;
    if (priority.ownerQueue.length > 0) return false;
    if ((priority.running.get(owner) ?? 0) >= 1) return false;
    const backgroundCapacity = Math.max(1, this.limits.maxRunningGlobal - 1);
    if (priority.runningTotal >= backgroundCapacity || this.runningTotal >= this.limits.maxRunningGlobal) return false;
    return !this.interactiveBusy() || at - enqueuedAt >= priority.maxWaitMs;
  }

  private interactiveBusy(): boolean {
    try {
      return this.priority?.interactive?.busy() === true;
    } catch {
      return false;
    }
  }

  /**
   * Whether `owner` may still be served: checked at every turn, immediately
   * before work starts. A store that cannot say is treated as a no (the
   * remote routes refuse such a credential too).
   */
  private stillAuthorized(owner: string): boolean {
    if (!this.isOwnerRevoked) return true;
    try {
      return !this.isOwnerRevoked(owner);
    } catch {
      return false;
    }
  }

  /**
   * Starts every waiting call that may start: the owner's own waiting calls
   * first, oldest first; then background calls in turn, where among
   * connections whose next call may start, the one with the earliest turn
   * (its last start, or else its next call's arrival) goes first. A call
   * whose connection was revoked never starts: its connection's whole queue
   * is cancelled before anyone else's turn.
   */
  private dispatch(): void {
    const priority = this.priority;
    if (!priority) return;
    for (;;) {
      const at = this.now();
      let granted: Waiter | undefined;
      for (const waiter of priority.ownerQueue) {
        if ((this.running.get(waiter.owner) ?? 0) >= this.limits.maxRunningPerOwner) continue;
        if (this.runningTotal >= this.limits.maxRunningGlobal) break;
        granted = waiter;
        break;
      }
      if (!granted) {
        let grantedTurn = 0;
        for (const [owner, queue] of priority.queues) {
          const head = queue[0]!;
          if (!this.backgroundMayStart(owner, head.enqueuedAt, at)) continue;
          const turn = Math.max(priority.lastServed.get(owner) ?? 0, head.tick);
          if (granted && turn >= grantedTurn) continue;
          granted = head;
          grantedTurn = turn;
        }
      }
      if (!granted) break;
      if (!this.stillAuthorized(granted.owner)) {
        this.cancelWaiting(granted.owner, callerAbortError('source_answer connection revoked'));
        continue;
      }
      granted.grant();
    }
    this.scheduleWaitCheck();
  }

  /** While the owner's work holds background answers back, wakes when the longest wait is up. */
  private scheduleWaitCheck(): void {
    const priority = this.priority!;
    clearTimeout(priority.timer);
    priority.timer = undefined;
    if (priority.queues.size === 0 || !this.interactiveBusy()) return;
    let oldest = Number.POSITIVE_INFINITY;
    for (const queue of priority.queues.values()) oldest = Math.min(oldest, queue[0]!.enqueuedAt);
    const delay = Math.max(0, oldest + priority.maxWaitMs - this.now());
    priority.timer = setTimeout(() => {
      priority.timer = undefined;
      this.dispatch();
    }, delay);
    priority.timer.unref?.();
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
      // A freed slot may be a waiting call's turn, whatever else has woken the queue before.
      this.dispatch();
    };
  }

  private admit(owner: string): void {
    if ((this.running.get(owner) ?? 0) >= this.limits.maxRunningPerOwner
      || this.runningTotal >= this.limits.maxRunningGlobal) {
      throw sourceAnswerBusy();
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

function sourceAnswerBusy(): OperationError {
  return new OperationError(
    'source_answer_busy',
    'Olympus is already answering as many questions as its analyst can take at once.',
    'Wait for the answers in progress (call source_answer_result with their job ids) before asking another question.',
  );
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

/**
 * A fresh job id. One that happens to look like a credential to the release
 * gate's scanner (a `-sk-…` run, say) is drawn again, so a job id never trips
 * an output scan.
 */
function newJobId(): string {
  for (;;) {
    const id = `${JOB_ID_PREFIX}${randomBytes(32).toString('base64url')}`;
    if (secretLabelsInText(id).length === 0) return id;
  }
}

function clampedInteger(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
