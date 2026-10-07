/**
 * Answers in flight on this worker (source answers, ChatGPT evidence
 * searches, private answer panel jobs). Answers come first: when the count
 * goes from 0 to 1 the worker preempts background model work (the tier
 * sniffer aborts its in-flight call), and while it is above 0 that work
 * yields (the sniffer's `shouldYield`). It resumes on its next tick.
 *
 * Each begin() is a lease. A lease never released (an answer whose promise
 * never settles, a begin() without its end()) would hold background work
 * off for good, so a lease older than `maxLeaseMs` stops counting: it is
 * expired, said once through `onExpired`, and the count heals.
 */
export interface AnswerActivity {
  readonly busy: boolean;
  readonly inFlight: number;
  /** Leases expired so far (begun, never ended within maxLeaseMs). */
  readonly expired: number;
  /** Starts one answer in flight; the returned release ends it (idempotent). */
  begin(): () => void;
  /** Ends the oldest open lease (for callers that do not keep the release). */
  end(): void;
  /** Runs `work` as one answer in flight. */
  run<T>(work: () => Promise<T>): Promise<T>;
}

export interface AnswerActivityOptions {
  /** A lease older than this stops counting. Default DEFAULT_ANSWER_LEASE_MS. */
  maxLeaseMs?: number;
  now?: () => number;
  /** Called once per expired lease, content-free: how long it was open. */
  onExpired?: (openMs: number) => void;
}

/** Longer than any bounded answer (the full private analysis caps well under it). */
export const DEFAULT_ANSWER_LEASE_MS = 20 * 60_000;

export function createAnswerActivity(onBusy: () => void, options: AnswerActivityOptions = {}): AnswerActivity {
  const maxLeaseMs = options.maxLeaseMs ?? DEFAULT_ANSWER_LEASE_MS;
  const now = options.now ?? Date.now;
  // Open leases, oldest first, by id → start time.
  const leases = new Map<number, number>();
  let nextId = 0;
  let expired = 0;
  const sweep = (): void => {
    const at = now();
    for (const [id, startedAt] of leases) {
      if (at - startedAt < maxLeaseMs) break;
      leases.delete(id);
      expired += 1;
      try {
        options.onExpired?.(at - startedAt);
      } catch {
        // Reporting never fails the count.
      }
    }
  };
  const activity: AnswerActivity = {
    get busy() {
      sweep();
      return leases.size > 0;
    },
    get inFlight() {
      sweep();
      return leases.size;
    },
    get expired() {
      sweep();
      return expired;
    },
    begin() {
      sweep();
      const id = nextId++;
      leases.set(id, now());
      if (leases.size === 1) {
        try {
          onBusy();
        } catch {
          // Preempting background work never fails an answer.
        }
      }
      return () => {
        leases.delete(id);
      };
    },
    end() {
      const oldest = leases.keys().next();
      if (!oldest.done) leases.delete(oldest.value);
    },
    async run(work) {
      const release = activity.begin();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
  return activity;
}
