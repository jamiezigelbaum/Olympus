/**
 * Keeps the worker's control path (health, the dashboard, approvals, pairing)
 * answering while sources import.
 *
 * Ingestion shares one JavaScript thread with the worker's Bun.serve. Most of
 * its work is synchronous (bun:sqlite writes, chunking, full-text indexing,
 * parsing), and a chain of `await`s over synchronous work resolves as
 * microtasks: it never hands the event loop back, so Bun.serve cannot accept or
 * answer a request until the whole chain ends. A yield every N items does not
 * bound that either, because N heavy items can take seconds, and several lanes
 * yielding to each other in turn multiply it. On 2026-11-03 five first imports
 * on Sparta held the thread at ~92% and every /health and dashboard request
 * timed out after 10 seconds (#784).
 *
 * The bound here is time, not items: every ingestion loop calls
 * `ingestionTurn()` once per unit of work, and it returns to the event loop
 * (a macrotask) once the thread has run `sliceMs` without one. With five lanes
 * that keeps the wait for any request's next step to a few slices. When the
 * loop itself is late (a timer firing well behind schedule means the thread is
 * saturated), the turn also rests briefly so requests already queued run first.
 *
 * One clock and one pending turn for the whole thread, shared by every lane:
 * the question is how long the thread has gone without turning, not how long
 * one lane has.
 */

export const CONTROL_PATH_SLICE_MS = 20;
/** How late a heartbeat may fire before ingestion rests for the control path. */
export const CONTROL_PATH_LAG_REST_THRESHOLD_MS = 200;
export const CONTROL_PATH_REST_MS = 25;
const HEARTBEAT_MS = 50;
/** A freeze this long is logged, with what was running, so the next one is named. */
export const CONTROL_PATH_FREEZE_LOG_MS = 2_000;

export interface ControlPathHeadroomOptions {
  sliceMs?: number;
  lagRestThresholdMs?: number;
  restMs?: number;
  now?: () => number;
  /** A macrotask boundary; tests inject one they can count. */
  turn?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  freezeLogMs?: number;
}

export class ControlPathHeadroom {
  private readonly sliceMs: number;
  private readonly lagRestThresholdMs: number;
  private readonly restMs: number;
  private readonly now: () => number;
  private readonly turn: (ms: number) => Promise<void>;
  private lastTurnAt: number;
  private pendingTurn: Promise<void> | undefined;
  private lastLagMs = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private expectedBeatAt = 0;
  private turns = 0;
  private rests = 0;
  private freezes = 0;
  private readonly active = new Map<string, number>();
  private readonly log: (line: string) => void;
  private readonly freezeLogMs: number;

  constructor(options: ControlPathHeadroomOptions = {}) {
    this.sliceMs = options.sliceMs ?? CONTROL_PATH_SLICE_MS;
    this.lagRestThresholdMs = options.lagRestThresholdMs ?? CONTROL_PATH_LAG_REST_THRESHOLD_MS;
    this.restMs = options.restMs ?? CONTROL_PATH_REST_MS;
    this.now = options.now ?? (() => performance.now());
    this.turn = options.turn ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    this.log = options.log ?? ((line) => console.error(line));
    this.freezeLogMs = options.freezeLogMs ?? CONTROL_PATH_FREEZE_LOG_MS;
    this.lastTurnAt = this.now();
  }

  /**
   * Marks a unit of background work as running, for the freeze log only.
   * Labels are fixed ids (a source id and task kind), never content.
   */
  enter(label: string): () => void {
    this.ensureHeartbeat();
    this.active.set(label, (this.active.get(label) ?? 0) + 1);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const count = (this.active.get(label) ?? 1) - 1;
      if (count <= 0) this.active.delete(label);
      else this.active.set(label, count);
    };
  }

  /**
   * Returns undefined (nothing to await) while the current slice has time
   * left, so a hot loop pays one clock read per item. Otherwise a promise that
   * settles after the event loop has turned.
   */
  ingestionTurn(): Promise<void> | undefined {
    this.ensureHeartbeat();
    // Every lane waits on the same turn. Separate timers, one per lane, would
    // all fire in one timer phase before the loop polls for requests, each
    // lane spending its own slice: five lanes made a 100-400 ms wall.
    if (this.pendingTurn) return this.pendingTurn;
    const now = this.now();
    if (now - this.lastTurnAt < this.sliceMs) return undefined;
    const rest = this.lastLagMs >= this.lagRestThresholdMs;
    if (rest) this.rests += 1;
    this.turns += 1;
    const pending = this.turn(rest ? this.restMs : 0).then(() => {
      this.pendingTurn = undefined;
      this.lastTurnAt = this.now();
    });
    this.pendingTurn = pending;
    return pending;
  }

  /** Counts only, for status and tests. */
  snapshot(): { turns: number; rests: number; freezes: number; lagMs: number } {
    return { turns: this.turns, rests: this.rests, freezes: this.freezes, lagMs: Math.round(this.lastLagMs) };
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /**
   * A timer that only fires when the loop turns: how late it fires is how long
   * the control path has been waiting. Started lazily by the first ingestion
   * turn or `enter`, and unref'd, so it never keeps a process alive.
   */
  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.expectedBeatAt = this.now() + HEARTBEAT_MS;
    this.heartbeat = setInterval(() => {
      const now = this.now();
      this.lastLagMs = Math.max(0, now - this.expectedBeatAt);
      this.expectedBeatAt = now + HEARTBEAT_MS;
      if (this.lastLagMs >= this.freezeLogMs) {
        this.freezes += 1;
        const running = [...this.active.keys()].sort().join(',') || 'none';
        this.log(`${new Date().toISOString()} [olympus:control-path] the worker could not answer requests for ${Math.round(this.lastLagMs)} ms; background work running: ${running}`);
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }
}

/** The worker's one thread, so one shared clock. */
export const controlPathHeadroom = new ControlPathHeadroom();

/** `await ingestionTurn()` once per unit of ingestion work. */
export function ingestionTurn(): Promise<void> | undefined {
  return controlPathHeadroom.ingestionTurn();
}

/** Opt-in: the file a worker appends CPU sample summaries to (one JSON line per interval). */
export const CPU_SAMPLE_LOG_ENV = 'OLYMPUS_CPU_SAMPLE_LOG';
const CPU_SAMPLE_FLUSH_MS = 30_000;
const CPU_SAMPLE_TOP = 30;

interface SampledFrame { name?: string; sourceID?: number; sourceURL?: string; line?: number; category?: string }

/**
 * Summarizes JSC sampling-profiler traces: the functions on top of the stack
 * (where the thread spends its own time) and every function on the stack
 * (what that time is spent under). Names and code positions only, never data.
 */
export function summarizeCpuSamples(
  traces: readonly { frames?: readonly SampledFrame[] }[],
  top = CPU_SAMPLE_TOP,
  sources: readonly { sourceID?: number; url?: string }[] = [],
): {
  samples: number; self: [string, number][]; total: [string, number][];
} {
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  // A frame may carry only its sourceID; the profiler's sources table maps it to a URL.
  const urls = new Map(sources.flatMap((source) => source.sourceID !== undefined && source.url ? [[source.sourceID, source.url] as const] : []));
  const key = (frame: SampledFrame) => {
    const url = frame.sourceURL ?? (frame.sourceID !== undefined ? urls.get(frame.sourceID) : undefined);
    const file = url ? url.split('/').slice(-2).join('/') : '';
    const line = frame.line !== undefined && frame.line < 0xffff_ffff ? `:${frame.line}` : '';
    return `${frame.name || '(anonymous)'}${file ? ` ${file}${line}` : ''}`;
  };
  for (const trace of traces) {
    const frames = trace.frames ?? [];
    if (frames.length === 0) continue;
    const leaf = key(frames[0]!);
    self.set(leaf, (self.get(leaf) ?? 0) + 1);
    for (const name of new Set(frames.map(key))) total.set(name, (total.get(name) ?? 0) + 1);
  }
  const rank = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  return { samples: traces.length, self: rank(self), total: rank(total) };
}

/**
 * When OLYMPUS_CPU_SAMPLE_LOG names a file, samples the worker's JavaScript
 * thread and appends a summary every 30 s. `bun --cpu-prof` writes only at a
 * clean exit, which a saturated worker never reaches (Sparta, 2026-11-03), and
 * ptrace samplers are blocked there. A gap in the file's timestamps means the
 * thread did not turn at all for that long.
 */
export async function startCpuSampleLog(env: Record<string, string | undefined> = process.env): Promise<(() => void) | undefined> {
  const path = env[CPU_SAMPLE_LOG_ENV]?.trim();
  if (!path) return undefined;
  const jsc = await import('bun:jsc') as unknown as {
    startSamplingProfiler?: () => void;
    samplingProfilerStackTraces?: () => { traces?: { frames?: SampledFrame[] }[]; sources?: { sourceID?: number; url?: string }[] };
  };
  if (!jsc.startSamplingProfiler || !jsc.samplingProfilerStackTraces) return undefined;
  const { appendFileSync } = await import('node:fs');
  jsc.startSamplingProfiler();
  let last = Date.now();
  const flush = () => {
    const now = Date.now();
    try {
      const sampled = jsc.samplingProfilerStackTraces!();
      const summary = summarizeCpuSamples(sampled.traces ?? [], CPU_SAMPLE_TOP, sampled.sources ?? []);
      appendFileSync(path, `${JSON.stringify({ at: new Date(now).toISOString(), windowMs: now - last, headroom: controlPathHeadroom.snapshot(), ...summary })}\n`, { mode: 0o600 });
    } catch (error) {
      console.error(`[olympus:control-path] cpu sample log failed: ${error instanceof Error ? error.name : 'error'}`);
    }
    last = now;
  };
  const timer = setInterval(flush, CPU_SAMPLE_FLUSH_MS);
  timer.unref?.();
  console.error(`[olympus:control-path] sampling CPU to ${CPU_SAMPLE_LOG_ENV}`);
  return () => clearInterval(timer);
}
