// Admission is decided before a scheduler unit starts. A held unit keeps only
// its first-deferral time. The scheduler brings it back for a fresh decision.
export type StandBackWork = 'import' | 'embed' | 'judge' | 'digest' | 'status' | 'watch' | 'prune' | 'reclaim' | 'recency';
type Unit = string | object;

/** The longest one kind of work waits for the owner's Ask before it runs anyway. */
export const STAND_BACK_MAX_MS = 60_000;
/** How long it then runs before it stands back again. */
export const STAND_BACK_SHARE_MS = 15_000;

export interface StandBackCounts {
  work_kind: StandBackWork;
  held_count: number;
  wait_reason?: 'owner_ask';
  /** Individual units entering a hold, excluding repeat declines. */
  holds: number;
  /** Elapsed time with at least one unit held, excluding overlap. */
  held_ms: number;
  bound_reached: number;
  holding: boolean;
  reason?: string;
}

export interface StandBack {
  /** True while `work` should start nothing new. */
  holds(work: StandBackWork, unit?: Unit): boolean;
  /** The pending unit was removed or admitted by an operator. */
  clear(work: StandBackWork, unit: Unit): void;
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
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? ((line: string) => console.log(line));
  const maxMs = options.maxMs ?? STAND_BACK_MAX_MS;
  const shareMs = options.shareMs ?? STAND_BACK_SHARE_MS;
  interface WorkState {
    pending: Map<Unit, number>;
    since: number;
    shareUntil: number;
    holds: number;
    heldMs: number;
    bounds: number;
    reason: string;
  }
  const states = new Map<StandBackWork, WorkState>();
  const seconds = (ms: number) => Math.round(ms / 1_000);
  function release(work: StandBackWork, state: WorkState, unit: Unit, at: number) {
    if (state.pending.delete(unit) && state.pending.size === 0) {
      state.heldMs += at - state.since;
      log(`Olympus engine: ${work} resumes after standing back ${seconds(at - state.since)} s (${state.reason}).`);
    }
  }
  return {
    holds(work, unit = work) {
      const at = now();
      let reason: string | undefined;
      try { reason = options.reason(); } catch { reason = undefined; }
      let state = states.get(work);
      if (!reason) {
        if (state) {
          release(work, state, unit, at);
          state.shareUntil = 0;
        }
        return false;
      }
      if (!state) {
        state = { pending: new Map(), since: at, shareUntil: 0, holds: 0, heldMs: 0, bounds: 0, reason };
        states.set(work, state);
      }
      const since = state.pending.get(unit);
      // Physical reclaim is idle-only, even during a prune share.
      if (work !== 'reclaim') {
        const overdue = since !== undefined && at - since >= maxMs;
        if (overdue) {
          state.bounds++;
          state.shareUntil = at + shareMs;
          log(`Olympus engine: ${work} reached its Ask bound; runs ${seconds(shareMs)} s before standing back again.`);
        }
        if (overdue || at < state.shareUntil) {
          release(work, state, unit, at);
          return false;
        }
      }
      if (since === undefined) {
        if (state.pending.size === 0) {
          state.since = at;
          log(`Olympus engine: ${work} stands back for the owner's Ask (${reason}).`);
        }
        state.pending.set(unit, at);
        state.holds++;
      }
      state.reason = reason;
      return true;
    },
    clear(work, unit) {
      const state = states.get(work);
      if (state) release(work, state, unit, now());
    },
    counts() {
      const at = now();
      return Object.fromEntries([...states].map(([work, state]) => [work, {
        work_kind: work,
        holds: state.holds,
        held_ms: Math.round(state.heldMs + (state.pending.size ? at - state.since : 0)),
        bound_reached: state.bounds,
        held_count: state.pending.size,
        holding: state.pending.size > 0,
        ...(state.pending.size ? { wait_reason: 'owner_ask', reason: state.reason } : {}),
      }]));
    },
  };
}
