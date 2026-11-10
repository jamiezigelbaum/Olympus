import { AsyncLocalStorage } from 'node:async_hooks';

let localInferencePriority: AsyncLocalStorage<AnswerLeaseKind | 'maintenance'> | undefined;
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

/** Classification dispatches yield to waiting answers on a shared model. */
export function runClassificationInference<T>(work: () => Promise<T>): Promise<T> {
  localInferencePriority ??= new AsyncLocalStorage();
  return localInferencePriority.run('maintenance', work);
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

/** How long a queued classification call waits behind background answers before it ranks with them. */
export const MAINTENANCE_AGING_MS = 60_000;

/** Actual local inference leases, separate from search/answer UI activity. */
export function localModelResourceKey(profile: { baseUrl?: string; model?: string }): string {
  return `${profile.baseUrl?.replace(/\/+$/, '') ?? ''}\u0000${profile.model ?? ''}`;
}

export function createLocalModelActivity() {
  const queues = new Map<string, { running: number[]; tasks: Array<{ priority: number; limit: number; queuedAt: number; run: () => Promise<void> }> }>();
  // `limit` is how many calls on this resource may run alongside this one. The
  // next task in owner-first order starts only while fewer run than its own
  // limit and the limit of every call already running, so an owner call
  // (limit 1) always runs alone.
  const dispatch = <T>(key: string, work: () => Promise<T>, limit = 1): Promise<T> => new Promise((resolve, reject) => {
    let queue = queues.get(key);
    if (!queue) { queue = { running: [], tasks: [] }; queues.set(key, queue); }
    const pending = queue;
    const pump = () => {
      while (pending.tasks.length > 0) {
        const now = Date.now();
        // A classification call that has waited a minute ranks with background
        // answers, oldest first, so a steady stream of them cannot starve it.
        // The owner's own calls still go first.
        const rank = (task: { priority: number; queuedAt: number }) => task.priority === 2 && now - task.queuedAt >= MAINTENANCE_AGING_MS ? 1 : task.priority;
        const first = pending.tasks.reduce((best, task, index) => rank(task) < rank(pending.tasks[best]!) ? index : best, 0);
        if (pending.running.length >= Math.min(pending.tasks[first]!.limit, ...pending.running)) return;
        const next = pending.tasks.splice(first, 1)[0]!;
        pending.running.push(next.limit);
        void next.run().finally(() => { pending.running.splice(pending.running.indexOf(next.limit), 1); pump(); });
      }
    };
    const kind = localInferencePriority?.getStore() ?? 'owner';
    // An owner call that must wait for a busy resource preempts at once, not
    // when its own call starts: a classification call already running would
    // otherwise finish first, 30-100 s on a 4-core CPU (#1033). Preempting
    // cancels it (llama-server stops a cancelled prompt within a 64-token
    // batch) and no new one starts ahead of this call (owner-first order).
    if (kind === 'owner' && pending.running.length > 0) notifyBusy(key);
    pending.tasks.push({ priority: localInferencePriority?.getStore() === 'background' ? 1 : localInferencePriority?.getStore() === 'maintenance' ? 2 : 0, limit: Math.max(1, Math.floor(limit)), queuedAt: Date.now(), run: async () => {
      try { resolve(await (localInferencePriority ? localInferencePriority.run(kind, () => lease(key, work)) : lease(key, work))); } catch (error) { reject(error); }
    } });
    // Gather simultaneous dispatches before choosing owner-first.
    queueMicrotask(pump);
  });
  const taggedRunning = new Map<string, number>();
  // The owner's own calls in flight per resource (every call not run as
  // background or maintenance), so a fair turn never outlasts one (#1031).
  const ownerRunning = new Map<string, number>();
  const lease = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const store = localInferencePriority?.getStore();
    const owner = store !== 'background' && store !== 'maintenance';
    if (owner) ownerRunning.set(key, (ownerRunning.get(key) ?? 0) + 1);
    try {
      return await get(key).run(work);
    } finally {
      if (owner) ownerRunning.set(key, (ownerRunning.get(key) ?? 1) - 1);
    }
  };
  const resources = new Map<string, ReturnType<typeof createAnswerActivity>>();
  const busyListeners = new Map<string, Set<() => void>>();
  const notifyBusy = (key: string): void => {
    for (const listener of busyListeners.get(key) ?? []) {
      try { listener(); } catch { /* Preempting background work never fails an answer. */ }
    }
  };
  const get = (key: string) => {
    let activity = resources.get(key);
    if (!activity) {
      activity = createAnswerActivity(() => {
        if (localInferencePriority?.getStore() !== 'background' && localInferencePriority?.getStore() !== 'maintenance') notifyBusy(key);
      });
      resources.set(key, activity);
    }
    return activity;
  };
  return {
    busy: (key: string) => get(key).busy,
    // Busy with calls other than the ones tracked under `tag`.
    busyExcept: (key: string, tag: string) => get(key).inFlight > (taggedRunning.get(`${key}\u0000${tag}`) ?? 0),
    // True while one of the owner's own calls runs on this resource.
    ownerInFlight: (key: string) => (ownerRunning.get(key) ?? 0) > 0,
    run: <T>(key: string, work: () => Promise<T>) => lease(key, work),
    onBusy(key: string, listener: () => void) {
      const listeners = busyListeners.get(key) ?? new Set<() => void>();
      busyListeners.set(key, listeners);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onIdle: (key: string, listener: () => void) => get(key).onInteractiveIdle(listener),
    // `concurrency` lets this caller's calls share the resource with up to that
    // many in flight (default 1); owner work is still started first.
    // `tag` names the caller's own calls, so `busyExcept` can tell whether
    // anyone else holds the resource (a caller never yields to itself).
    track<T extends import('../core/analyst.ts').AnalystModel & { prepareSniffer?(signal?: AbortSignal): Promise<void> }>(key: string, model: T, options: { serialize?: boolean; concurrency?: number; tag?: string } = {}): T {
      const coordinate = <R>(work: () => Promise<R>, signal?: AbortSignal, limit = options.concurrency ?? 1): Promise<R> => {
        const guards = localInferenceGuards?.getStore() ?? [];
        const run = options.serialize === false ? <V>(work: () => Promise<V>) => lease(key, work) :<V>(work: () => Promise<V>) => dispatch(key, work, limit);
        return run(async () => {
          const tagKey = options.tag === undefined ? undefined : `${key}\u0000${options.tag}`;
          if (tagKey !== undefined) taggedRunning.set(tagKey, (taggedRunning.get(tagKey) ?? 0) + 1);
          try {
            signal?.throwIfAborted();
            for (const guard of guards) {
              try { await guard(); } catch (error) {
                signal?.throwIfAborted();
                throw error;
              }
            }
            signal?.throwIfAborted();
            return await work();
          } finally {
            if (tagKey !== undefined) taggedRunning.set(tagKey, (taggedRunning.get(tagKey) ?? 1) - 1);
          }
        });
      };
      return { ...model,
        // Probes and priming use the same slot as completions, exclusively.
        ...(model.prepareSniffer ? { prepareSniffer: (signal?: AbortSignal) => coordinate(() => model.prepareSniffer!(signal), signal, 1) } : {}),
        complete: request => coordinate(() => model.complete(request), request.signal),
      };
    },
  };
}
export type LocalModelActivity = ReturnType<typeof createLocalModelActivity>;
