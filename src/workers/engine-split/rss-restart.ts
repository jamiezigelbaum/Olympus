/**
 * The background's supervised restart on memory (docs/design/engine-split.md,
 * part 3, "Restart"; #957). With `worker.engineSplit` on, the background
 * checks its five-minute RSS floor every minute. Past the threshold it waits
 * for judge and scheduler work in flight to end, then asks for the clean
 * reload used by model changes. The scheduler records any pass it cuts
 * short as interrupted (#803), the process exits 75, and the host's
 * supervision starts it again. A pass
 * that runs past ENGINE_RSS_RESTART_MAX_WAIT_MS does not hold it back: a
 * stopped pass loses nothing it had not committed.
 *
 * Each restart is one log line with a fixed prefix (`[engine-split]
 * rss_restart rss_mb=`), which a sampler counts, and the running count is in
 * the status snapshot (`rss_restarts`), carried from one background to the
 * next through the snapshot it left.
 */
import { createMemoryDiagnostic, MEMORY_SAMPLE_INTERVAL_MS, processMemory, type ProcessMemory } from './memory.ts';
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
  sample?: () => ProcessMemory;
  /** Judge or scheduler work is running: the restart waits for it to end. */
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
  memory?: ReturnType<typeof createMemoryDiagnostic>;
}): { restarts(): EngineRssRestarts; stop(): void } {
  const now = input.now ?? (() => Date.now());
  const log = input.log ?? ((line: string) => console.warn(line));
  const memory = input.memory ?? createMemoryDiagnostic({ role: 'background', now, log });
  let restarts: EngineRssRestarts = input.previous;
  let overSince: number | undefined;
  let done = false;
  const sample = input.sample ?? processMemory;
  const threshold = input.thresholdMb * 1024 * 1024;
  const check = (sampled: ProcessMemory, rss: number): void => {
    const periodic = () => { if (memory.dueOnMinuteCheck()) memory.write(sampled); };
    if (done || input.thresholdMb <= 0) { periodic(); return; }
    const floor = memory.floor();
    if (!floor?.full || floor.rss <= threshold) {
      overSince = undefined;
      if (floor && rss > threshold && floor.rss < threshold) memory.recordBurst(rss, floor.rss, input.thresholdMb);
      periodic();
      return;
    }
    overSince ??= now();
    const waited = now() - overSince;
    if (input.batchRunning() && waited < ENGINE_RSS_RESTART_MAX_WAIT_MS) { periodic(); return; }
    done = true;
    const rssMb = Math.round(rss / (1024 * 1024));
    const next = { count: restarts.count + 1, last: { at: new Date(now()).toISOString(), rss_mb: rssMb } };
    const previous = restarts;
    restarts = next;
    input.record(next);
    const fields = memory.write(sampled);
    if (!input.restart()) {
      restarts = previous;
      log(`[engine-split] rss_over_threshold rss_mb=${rssMb} threshold_mb=${input.thresholdMb}: nothing supervises this process, so it keeps running.`);
      return;
    }
    log(`[engine-split] rss_restart rss_mb=${rssMb} threshold_mb=${input.thresholdMb} restarts=${next.count} waited_ms=${waited} over_threshold_s=${Math.floor(waited / 1000)} ${fields}`);
  };
  const setTimer = input.setInterval ?? ((callback, ms) => { const handle = setInterval(callback, ms); handle.unref?.(); return handle; });
  const clearTimer = input.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let samplesSinceCheck = 0;
  // Record the latest sample before checking so the first check at five
  // minutes sees a complete window, even when both would be due together.
  const sampler = setTimer(() => {
    const sampled = sample();
    const rss = input.rss?.() ?? sampled.anon ?? sampled.rss;
    memory.sample(sampled, rss);
    if (++samplesSinceCheck * MEMORY_SAMPLE_INTERVAL_MS < ENGINE_RSS_CHECK_INTERVAL_MS) return;
    samplesSinceCheck = 0;
    check(sampled, rss);
  }, MEMORY_SAMPLE_INTERVAL_MS);
  return {
    restarts: () => restarts,
    stop: () => clearTimer(sampler),
  };
}

/**
 * The memory the restart measures: on Linux the process's anonymous RSS
 * (RssAnon), so the SQLite files it maps for reads (sqlite-mmap.ts), which
 * are the files' own page cache, never count as its memory; elsewhere total
 * RSS, as before (mapping is Linux-only too).
 */
export function engineMemoryRss(): number {
  const memory = processMemory();
  return memory.anon ?? memory.rss;
}
