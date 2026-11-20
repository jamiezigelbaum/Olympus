/**
 * The split's background recounts what the dashboard and status show on its
 * own pace, never on a request (docs/design/engine-split.md, part 3). Each
 * recount is followed by a rest several times as long as it took, so the
 * recount never takes more than a small share of the engine however large
 * the stores grow, and it stands back while the owner asks. Each recount's
 * length is logged and the last one is in health.
 */
export const STATUS_RECOUNT_MIN_GAP_MS = 30_000;
/** Rest = this many times the last recount's length (at most 1/(1+5) of the engine's time). */
export const STATUS_RECOUNT_PACE_FACTOR = 5;

interface StatusRecountUnit {
  key: string;
  run: () => Promise<unknown>;
}

/** A declined unit is the next unit on the next dispatch, even as stores are added. */
export function createStatusRecountPass(holds: (key: string) => boolean, clear: (key: string) => void) {
  let nextKey: string | undefined;
  return async (units: readonly StatusRecountUnit[]): Promise<boolean> => {
    const pending = units.findIndex(unit => unit.key === nextKey);
    if (pending < 0 && nextKey !== undefined) clear(nextKey);
    const start = Math.max(0, pending);
    for (let index = start; index < units.length; index += 1) {
      const unit = units[index]!;
      nextKey = unit.key;
      if (holds(unit.key)) return index > start;
      await unit.run();
    }
    nextKey = undefined;
    return true;
  };
}

export interface StatusRecountHealth {
  runs: number;
  failures: number;
  last_ms?: number;
  /** How long ago the last recount finished. */
  age_ms?: number;
  /** Whether one is running now. */
  counting: boolean;
}

export interface PacedStatusRecount {
  stop(): void;
  /**
   * Something the counts show changed (a source, a finished sync pass): count
   * again without the idle floor, but never sooner than the pace allows
   * (PACE_FACTOR times the last recount after it). One running finishes first.
   */
  soon(): void;
  health(): StatusRecountHealth;
}

export function startPacedStatusRecount(options: {
  /** False when the next optional unit was held before any optional work ran. */
  recount: () => Promise<boolean | void>;
  schedule?: (run: () => void, ms: number) => () => void;
  now?: () => number;
  log?: (line: string) => void;
}): PacedStatusRecount {
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((run: () => void, ms: number) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  });
  let stopped = false;
  let runs = 0;
  let failures = 0;
  let lastMs: number | undefined;
  let lastAt: number | undefined;
  let counting = false;
  let wanted = false;
  let due = 0;
  let nextAllowed = 0;
  let cancel: (() => void) | undefined;
  const arm = (at: number) => {
    cancel?.();
    due = at;
    cancel = schedule(() => { cancel = undefined; void run(); }, Math.max(0, at - now()));
  };
  const run = async () => {
    if (stopped) return;
    const started = now();
    counting = true;
    let worked = true;
    try {
      worked = await options.recount() !== false;
    } catch (error) {
      failures += 1;
      options.log?.(`[olympus] status recount failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      counting = false;
    }
    const finished = now();
    const elapsed = Math.max(0, finished - started);
    nextAllowed = finished + STATUS_RECOUNT_PACE_FACTOR * elapsed;
    const gap = Math.max(STATUS_RECOUNT_MIN_GAP_MS, STATUS_RECOUNT_PACE_FACTOR * elapsed);
    if (worked) {
      runs += 1;
      lastMs = elapsed;
      lastAt = finished;
      options.log?.(`[olympus] status recount took ${Math.round(elapsed)} ms; next in ${Math.round(gap / 1000)} s`);
    } else {
      // Keep retrying on the ordinary cadence. A signal from intake cannot
      // make a held unit spin, or keep repeating the required settlement walk.
      nextAllowed = finished + gap;
    }
    if (!stopped) arm(wanted ? nextAllowed : finished + gap);
    wanted = false;
  };
  void run();
  return {
    stop: () => { stopped = true; cancel?.(); },
    soon: () => {
      if (stopped) return;
      if (counting) { wanted = true; return; }
      if (nextAllowed >= due) return;
      const at = now();
      if (nextAllowed <= at) {
        cancel?.();
        cancel = undefined;
        void run();
      } else arm(nextAllowed);
    },
    health: () => ({
      runs, failures, counting,
      ...(lastMs !== undefined ? { last_ms: lastMs } : {}),
      ...(lastAt !== undefined ? { age_ms: Math.max(0, now() - lastAt) } : {}),
    }),
  };
}
