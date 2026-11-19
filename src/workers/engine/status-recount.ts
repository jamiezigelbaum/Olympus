import type { BackgroundWalkPause } from './stand-back.ts';

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
const STATUS_RECOUNT_HELD_RETRY_MS = 5_000;

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
  recount: (pause: BackgroundWalkPause) => Promise<void>;
  pause?: BackgroundWalkPause;
  /** True while the owner's own question holds background work (stand-back.ts). */
  holds: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}): PacedStatusRecount {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
  let stopped = false;
  let runs = 0;
  let failures = 0;
  let lastMs: number | undefined;
  let lastAt: number | undefined;
  let counting = false;
  let wanted = false;
  let wake: (() => void) | undefined;
  const rest = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    wake = resolve;
    void sleep(ms).then(resolve);
  }).finally(() => { wake = undefined; });
  void (async () => {
    while (!stopped) {
      if (options.holds()) { await sleep(STATUS_RECOUNT_HELD_RETRY_MS); continue; }
      const started = now();
      let parkedMs = 0;
      const pause = () => {
        const waiting = options.pause?.();
        if (!waiting) return;
        const at = now();
        return waiting.finally(() => { parkedMs += now() - at; });
      };
      counting = true;
      try {
        await options.recount(pause);
      } catch (error) {
        failures += 1;
        options.log?.(`[olympus] status recount failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        counting = false;
      }
      runs += 1;
      lastMs = Math.max(0, now() - started - parkedMs);
      lastAt = now();
      const gap = Math.max(STATUS_RECOUNT_MIN_GAP_MS, STATUS_RECOUNT_PACE_FACTOR * lastMs);
      options.log?.(`[olympus] status recount took ${lastMs} ms; next in ${Math.round(gap / 1000)} s`);
      if (stopped) break;
      if (wanted) { wanted = false; await rest(STATUS_RECOUNT_PACE_FACTOR * lastMs); continue; }
      await rest(gap);
      wanted = false;
    }
  })();
  return {
    stop: () => { stopped = true; wake?.(); },
    soon: () => {
      if (!wake) { wanted = true; return; }
      const due = (lastAt ?? 0) + STATUS_RECOUNT_PACE_FACTOR * (lastMs ?? 0);
      const waitMs = due - now();
      if (waitMs <= 0) { wake(); return; }
      const resting = wake;
      void sleep(waitMs).then(() => { if (wake === resting) resting(); });
    },
    health: () => ({
      runs, failures, counting,
      ...(lastMs !== undefined ? { last_ms: lastMs } : {}),
      ...(lastAt !== undefined ? { age_ms: Math.max(0, now() - lastAt) } : {}),
    }),
  };
}
