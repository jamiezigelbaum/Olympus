/**
 * The background's supervised restart on memory (docs/design/engine-split.md,
 * part 3, "Restart"; #957). With `worker.engineSplit` on, the background
 * checks its own RSS every minute. Past the threshold it waits for the
 * judge's pass in flight to end, so the restart falls between batches, and
 * then asks for the same clean reload a model change uses: the scheduler
 * stops and records a pass it cuts short as interrupted, not failed (#803),
 * the process exits 75, and the host's supervision starts it again. A pass
 * that runs past ENGINE_RSS_RESTART_MAX_WAIT_MS does not hold it back: a
 * stopped pass loses nothing it had not committed.
 *
 * Each restart is one log line with a fixed prefix (`[engine-split]
 * rss_restart rss_mb=`), which a sampler counts, and the running count is in
 * the status snapshot (`rss_restarts`), carried from one background to the
 * next through the snapshot it left.
 */
import type { EngineStatusRead } from './snapshot.ts';

export { ENGINE_RSS_RESTART_DEFAULT_MB } from '../../core/config.ts';
export const ENGINE_RSS_CHECK_INTERVAL_MS = 60_000;
export const ENGINE_RSS_RESTART_MAX_WAIT_MS = 10 * 60_000;

export interface EngineRssRestarts {
  count: number;
  last?: { at: string; rss_mb: number };
}

/** The count the last background published, or none. Never throws. */
export function engineRssRestartsFrom(read: EngineStatusRead | undefined): EngineRssRestarts {
  const value = read?.snapshot.rss_restarts;
  if (!value || !Number.isSafeInteger(value.count) || value.count < 0) return { count: 0 };
  const last = value.last;
  return {
    count: value.count,
    ...(last && typeof last.at === 'string' && Number.isFinite(last.rss_mb) ? { last: { at: last.at, rss_mb: last.rss_mb } } : {}),
  };
}

export function startEngineRssRestart(input: {
  /** 0 turns it off. */
  thresholdMb: number;
  rss?: () => number;
  /** A judge pass is running: the restart waits for it to end. */
  batchRunning: () => boolean;
  /** The clean reload; false when nothing supervises this process. */
  restart: () => boolean;
  /** Called with the new count before the restart is asked for, to publish it. */
  record: (restarts: EngineRssRestarts) => void;
  previous: EngineRssRestarts;
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  log?: (line: string) => void;
}): { restarts(): EngineRssRestarts; stop(): void } {
  const now = input.now ?? (() => Date.now());
  const rss = input.rss ?? (() => process.memoryUsage.rss());
  const log = input.log ?? ((line: string) => console.warn(line));
  let restarts: EngineRssRestarts = input.previous;
  let overSince: number | undefined;
  let done = false;
  const check = (): void => {
    if (done || input.thresholdMb <= 0) return;
    const rssMb = Math.round(rss() / (1024 * 1024));
    if (rssMb < input.thresholdMb) { overSince = undefined; return; }
    overSince ??= now();
    const waited = now() - overSince;
    if (input.batchRunning() && waited < ENGINE_RSS_RESTART_MAX_WAIT_MS) return;
    done = true;
    const next = { count: restarts.count + 1, last: { at: new Date(now()).toISOString(), rss_mb: rssMb } };
    const previous = restarts;
    restarts = next;
    input.record(next);
    if (!input.restart()) {
      restarts = previous;
      log(`[engine-split] rss_over_threshold rss_mb=${rssMb} threshold_mb=${input.thresholdMb}: nothing supervises this process, so it keeps running.`);
      return;
    }
    log(`[engine-split] rss_restart rss_mb=${rssMb} threshold_mb=${input.thresholdMb} restarts=${next.count} waited_ms=${waited}`);
  };
  const timer = (input.setInterval ?? ((callback, ms) => { const handle = setInterval(callback, ms); handle.unref?.(); return handle; }))(check, ENGINE_RSS_CHECK_INTERVAL_MS);
  return {
    restarts: () => restarts,
    stop: () => (input.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)))(timer),
  };
}
