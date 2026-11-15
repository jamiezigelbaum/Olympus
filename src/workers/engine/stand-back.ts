// Background work stands back while the owner asks something, and never
// without a bound. One rule for every kind of background work: imports
// (the scheduler), embedding, the privacy judge and each store's vector
// digest backfill stand back for at
// most STAND_BACK_MAX_MS at a time and then get STAND_BACK_SHARE_MS to run
// even while the owner keeps asking, so each keeps a guaranteed share.
//
// A hold is never silent: its start, its end (or the bound) and how long it
// lasted are logged with the reason, and counted for the engine's health.
// Lane 6 archive-scale leg, 15 Nov 2026: an unbounded, unlogged stand-back
// held imports for most of an hour (mbox passes 5 to 20 min apart).

export type StandBackWork = 'import' | 'embed' | 'judge' | 'digest' | 'status';

/** The longest one kind of work waits for the owner's Ask before it runs anyway. */
export const STAND_BACK_MAX_MS = 60_000;
/** How long it then runs before it stands back again. */
export const STAND_BACK_SHARE_MS = 15_000;

export interface StandBackCounts {
  holds: number;
  held_ms: number;
  bound_reached: number;
  holding: boolean;
  reason?: string;
}

export interface StandBack {
  /** True while `work` should start nothing new. */
  holds(work: StandBackWork): boolean;
  /** Per kind of work, for health; only kinds that ever stood back. */
  counts(): Partial<Record<StandBackWork, StandBackCounts>>;
}

/**
 * Why background work stands back now: only the owner's own question, in
 * this process or relayed from the split's front. Never the shared
 * read-priority lease, which background answers and private-match probes
 * hold too.
 */
export function ownerAskReason(local: { readonly busy: boolean }, frontBusy: () => boolean): string | undefined {
  if (local.busy) return 'question in this process';
  return frontBusy() ? 'question in the front' : undefined;
}

export function createStandBack(options: {
  /** Why the owner is busy now, or undefined when not. */
  reason: () => string | undefined;
  now?: () => number;
  log?: (line: string) => void;
  maxMs?: number;
  shareMs?: number;
}): StandBack {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const maxMs = options.maxMs ?? STAND_BACK_MAX_MS;
  const shareMs = options.shareMs ?? STAND_BACK_SHARE_MS;
  const states = new Map<StandBackWork, { since?: number | undefined; shareUntil?: number | undefined; reason?: string | undefined; counts: Omit<StandBackCounts, 'holding' | 'reason'> }>();
  const seconds = (ms: number) => Math.round(ms / 1_000);
  return {
    holds(work) {
      const at = now();
      let reason: string | undefined;
      try { reason = options.reason(); } catch { reason = undefined; }
      let state = states.get(work);
      if (!reason) {
        if (state?.since !== undefined) {
          state.counts.held_ms += at - state.since;
          log(`Olympus engine: ${work} resumes after standing back ${seconds(at - state.since)} s (${state.reason}).`);
          state.since = undefined;
        }
        if (state) state.shareUntil = undefined;
        return false;
      }
      if (!state) states.set(work, state = { counts: { holds: 0, held_ms: 0, bound_reached: 0 } });
      if (state.shareUntil !== undefined && at < state.shareUntil) return false;
      state.shareUntil = undefined;
      if (state.since === undefined) {
        state.since = at;
        state.reason = reason;
        state.counts.holds += 1;
        log(`Olympus engine: ${work} stands back for the owner's Ask (${reason}).`);
        return true;
      }
      if (at - state.since >= maxMs) {
        state.counts.held_ms += at - state.since;
        state.counts.bound_reached += 1;
        log(`Olympus engine: ${work} stood back ${seconds(at - state.since)} s (${state.reason}); runs ${seconds(shareMs)} s before standing back again.`);
        state.since = undefined;
        state.shareUntil = at + shareMs;
        return false;
      }
      return true;
    },
    counts() {
      const at = now();
      return Object.fromEntries([...states].map(([work, state]) => [work, {
        ...state.counts,
        held_ms: state.counts.held_ms + (state.since !== undefined ? at - state.since : 0),
        holding: state.since !== undefined,
        ...(state.since !== undefined && state.reason ? { reason: state.reason } : {}),
      }]));
    },
  };
}
