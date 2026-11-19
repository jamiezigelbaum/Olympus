import { statSync } from 'node:fs';

/** Counts across the first visibility build in this process. No store identities. */
export interface StartupProgress {
  stores_done: number;
  stores_total: number;
  estimated_ready_at?: string;
}

let current: StartupProgress | undefined;

export function startupProgress(): StartupProgress | undefined {
  return current ? { ...current } : undefined;
}

export function beginStartupProgress(dbPaths: readonly string[], now = Date.now) {
  const startedAt = now();
  const progress: StartupProgress = { stores_done: 0, stores_total: dbPaths.length };
  if (dbPaths.length > 0) current = progress;
  const weights = dbPaths.map((path) => {
    try {
      return Math.max(1, statSync(path, { throwIfNoEntry: false })?.size ?? 0);
    } catch (error) {
      console.warn('[olympus] Could not stat a store for startup progress:', error);
      return 1;
    }
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let finishedWeight = 0;
  return {
    storeReady(index: number) {
      progress.stores_done += 1;
      finishedWeight += weights[index]!;
      const elapsed = now() - startedAt;
      const estimate = startedAt + elapsed * totalWeight / finishedWeight;
      if (Number.isFinite(estimate) && estimate >= startedAt && estimate <= 8.64e15) {
        progress.estimated_ready_at = new Date(estimate).toISOString();
      }
    },
    finish() {
      if (current === progress) current = undefined;
    },
  };
}

/** Also embedded as a standalone function in the waiting pages. */
export function startupWaitingLine(progress: StartupProgress | null | undefined, at = Date.now()): string {
  if (!progress || !Number.isSafeInteger(progress.stores_done) || !Number.isSafeInteger(progress.stores_total)
    || progress.stores_done < 0 || progress.stores_total <= 0 || progress.stores_done > progress.stores_total) return '';
  const left = typeof progress.estimated_ready_at === 'string'
    ? Math.ceil((Date.parse(progress.estimated_ready_at) - at) / 60_000)
    : NaN;
  // An estimate that has passed is said so: the line never reads as a promise, and no clock ends the answer.
  const eta = !Number.isFinite(left) ? '' : left > 0 ? `, about ${left} min left` : ', taking longer than estimated and still working';
  const sources = progress.stores_total === 1 ? 'source' : 'sources';
  return `Olympus is still starting (${progress.stores_done} of ${progress.stores_total} ${sources} ready${eta}). Your answer will arrive by itself.`;
}
