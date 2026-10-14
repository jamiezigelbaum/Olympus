import { AsyncLocalStorage } from 'node:async_hooks';

let localInferencePriority: AsyncLocalStorage<AnswerLeaseKind> | undefined;
let localInferenceGuards: AsyncLocalStorage<readonly (() => Promise<void>)[]> | undefined;
/** Provider-internal context, outside the frozen Analyst contract. A queued
 * call repeats these live guards after waiting, immediately before dispatch. */
export function runWithLocalInferenceGuard<T>(guard: () => Promise<void>, work: () => Promise<T>): Promise<T> {
  localInferenceGuards ??= new AsyncLocalStorage();
  return localInferenceGuards.run([...(localInferenceGuards?.getStore() ?? []), guard], work);
}
/** Applies at each shared model dispatch, including later synthesis/audit calls. */
export function runBackgroundInference<T>(work: () => Promise<T>): Promise<T> {
  localInferencePriority ??= new AsyncLocalStorage();
  return localInferencePriority.run('background', work);
}

/**
 * Answers in flight on this worker (source answers, ChatGPT evidence
 * searches, private answer panel jobs). These leases coordinate owner and
 * background jobs, without implying local model contention. The separate
 * createLocalModelActivity registry wraps actual local inference dispatches
 * to preempt and resume sorting only on the resource in use.
 *
 * Each begin() is a lease. A lease never released (an answer whose promise
 * never settles, a begin() without its end()) would hold background work
 * off for good, so a lease older than `maxLeaseMs` stops counting: it is
 * expired, said once through `onExpired`, and the count heals.
 *
 * A lease is the owner's own work unless it says it is `background` (a remote
 * agent's answer on a connection that is not ChatGPT,
 * docs/design/background-agents.md section E). Both count as busy for the
 * job scheduler; only the owner's work counts as `interactive`, which queued
 * background answers wait behind (core/source-answer-jobs.ts priority), and
 * `onInteractiveIdle` says when the last of it ends.
 */
export type AnswerLeaseKind = 'owner' | 'background';

export interface AnswerActivity {
  readonly busy: boolean;
  readonly inFlight: number;
  /** The owner's own answers in flight (every lease not begun as background). */
  readonly interactiveInFlight: number;
  /** Leases expired so far (begun, never ended within maxLeaseMs). */
  readonly expired: number;
  /** Starts one answer in flight; the returned release ends it (idempotent). */
  begin(kind?: AnswerLeaseKind): () => void;
  /** Ends the oldest open lease (for callers that do not keep the release). */
  end(): void;
  /** Runs `work` as one answer in flight. */
  run<T>(work: () => Promise<T>, kind?: AnswerLeaseKind): Promise<T>;
  /** Calls `listener` (asynchronously) each time the owner's answers in flight drop to none; returns its removal. */
  onInteractiveIdle(listener: () => void): () => void;
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
  // Open leases, oldest first, by id → start time and kind.
  const leases = new Map<number, { startedAt: number; kind: AnswerLeaseKind }>();
  const idleListeners = new Set<() => void>();
  let interactive = 0;
  let nextId = 0;
  let expired = 0;
  const drop = (id: number): void => {
    const lease = leases.get(id);
    if (!lease) return;
    leases.delete(id);
    if (lease.kind === 'background') return;
    interactive -= 1;
    if (interactive > 0 || idleListeners.size === 0) return;
    // Never inside the caller's own release: listeners may start more work.
    queueMicrotask(() => {
      if (interactive > 0) return;
      for (const listener of [...idleListeners]) {
        try {
          listener();
        } catch {
          // A listener's failure never fails an answer.
        }
      }
    });
  };
  const sweep = (): void => {
    const at = now();
    for (const [id, { startedAt }] of leases) {
      if (at - startedAt < maxLeaseMs) break;
      drop(id);
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
    get interactiveInFlight() {
      sweep();
      return interactive;
    },
    get expired() {
      sweep();
      return expired;
    },
    begin(kind = 'owner') {
      sweep();
      const id = nextId++;
      leases.set(id, { startedAt: now(), kind });
      if (kind !== 'background') interactive += 1;
      if (leases.size === 1) {
        try {
          onBusy();
        } catch {
          // Preempting background work never fails an answer.
        }
      }
      return () => {
        drop(id);
      };
    },
    end() {
      const oldest = leases.keys().next();
      if (!oldest.done) drop(oldest.value);
    },
    onInteractiveIdle(listener) {
      idleListeners.add(listener);
      return () => {
        idleListeners.delete(listener);
      };
    },
    async run(work, kind) {
      const release = activity.begin(kind);
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
  return activity;
}

/** Actual local inference leases, separate from search/answer UI activity. */
export function localModelResourceKey(profile: { baseUrl?: string; model?: string }): string {
  return `${profile.baseUrl?.replace(/\/+$/, '') ?? ''}\u0000${profile.model ?? ''}`;
}

export function createLocalModelActivity() {
  const queues = new Map<string, { running: boolean; tasks: Array<{ background: boolean; run: () => Promise<void> }> }>();
  const dispatch = <T>(key: string, work: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    let queue = queues.get(key);
    if (!queue) { queue = { running: false, tasks: [] }; queues.set(key, queue); }
    const pending = queue;
    const pump = () => {
      if (pending.running) return;
      const owner = pending.tasks.findIndex(task => !task.background);
      const next = pending.tasks.splice(owner < 0 ? 0 : owner, 1)[0];
      if (!next) return;
      pending.running = true;
      void next.run().finally(() => { pending.running = false; pump(); });
    };
    pending.tasks.push({ background: localInferencePriority?.getStore() === 'background', run: async () => {
      try { resolve(await get(key).run(work)); } catch (error) { reject(error); }
    } });
    // Gather simultaneous dispatches before choosing owner-first.
    queueMicrotask(pump);
  });
  const resources = new Map<string, ReturnType<typeof createAnswerActivity>>();
  const busyListeners = new Map<string, Set<() => void>>();
  const get = (key: string) => {
    let activity = resources.get(key);
    if (!activity) {
      activity = createAnswerActivity(() => {
        for (const listener of busyListeners.get(key) ?? []) listener();
      });
      resources.set(key, activity);
    }
    return activity;
  };
  return {
    busy: (key: string) => get(key).busy,
    run: <T>(key: string, work: () => Promise<T>) => get(key).run(work),
    onBusy(key: string, listener: () => void) {
      const listeners = busyListeners.get(key) ?? new Set<() => void>();
      busyListeners.set(key, listeners);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onIdle: (key: string, listener: () => void) => get(key).onInteractiveIdle(listener),
    track<T extends import('../core/analyst.ts').AnalystModel>(key: string, model: T): T {
      return { ...model, complete: request => {
        const guards = localInferenceGuards?.getStore() ?? [];
        return dispatch(key, async () => {
          request.signal?.throwIfAborted();
          for (const guard of guards) {
            try { await guard(); } catch (error) {
              request.signal?.throwIfAborted();
              throw error;
            }
          }
          request.signal?.throwIfAborted();
          return model.complete(request);
        });
      } };
    },
  };
}
export type LocalModelActivity = ReturnType<typeof createLocalModelActivity>;
