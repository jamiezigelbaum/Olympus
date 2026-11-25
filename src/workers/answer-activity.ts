import { AsyncLocalStorage } from 'node:async_hooks';
import { currentModelProgress, runWithModelProgress } from '../core/model-stream.ts';

let localInferencePriority: AsyncLocalStorage<AnswerLeaseKind | 'maintenance'> | undefined;
let privacyReleaseInference: AsyncLocalStorage<boolean> | undefined;

/** Chunk release is owner work even through the shared classification model wrapper. */
export function runPrivacyReleaseInference<T>(work: () => Promise<T>): Promise<T> {
  privacyReleaseInference ??= new AsyncLocalStorage();
  localInferencePriority ??= new AsyncLocalStorage();
  return privacyReleaseInference.run(true, () => localInferencePriority!.run('owner', work));
}

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
  return localInferencePriority.run(privacyReleaseInference?.getStore() ? 'owner' : 'maintenance', work);
}

/** Who a model call is for: the owner, background answers, or maintenance (classification). */
export type LocalInferencePriority = AnswerLeaseKind | 'maintenance';

/** The priority the current call runs at; a call outside any is the owner's. */
export function currentLocalInferencePriority(): LocalInferencePriority {
  return localInferencePriority?.getStore() ?? 'owner';
}

/**
 * Runs work at a priority another process reported (the split's front
 * forwarding a completion): async context does not cross the socket.
 */
export function runAtLocalInferencePriority<T>(priority: LocalInferencePriority, work: () => Promise<T>): Promise<T> {
  localInferencePriority ??= new AsyncLocalStorage();
  return localInferencePriority.run(priority, work);
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

export class LocalModelPreempted extends DOMException {
  constructor() {
    super('The local model yielded to an owner call.', 'AbortError');
  }
}

interface LocalModelTask {
  priority: number;
  limit: number;
  queuedAt: number;
  preemption?: AbortController;
  progress?: (model: string) => void;
  run: () => Promise<void>;
}

/** Single-slot resources admit only one call and cancel lower-priority work for the owner. */
export function createLocalModelActivity({ singleSlotResources = [] }: { singleSlotResources?: readonly string[] } = {}) {
  const queues = new Map<string, { running: LocalModelTask[]; tasks: LocalModelTask[] }>();
  // `limit` is how many calls on this resource may run alongside this one. The
  // next task in owner-first order starts only while fewer run than its own
  // limit and the limit of every call already running, so an owner call
  // (limit 1) always runs alone.
  const dispatch = <T>(key: string, work: (preempted?: AbortSignal) => Promise<T>, limit: number): Promise<T> => new Promise((resolve, reject) => {
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
        if (pending.running.length >= Math.min(pending.tasks[first]!.limit, ...pending.running.map(task => task.limit))) return;
        const next = pending.tasks.splice(first, 1)[0]!;
        pending.running.push(next);
        void next.run().finally(() => { pending.running.splice(pending.running.indexOf(next), 1); pump(); });
      }
    };
    const kind = currentLocalInferencePriority();
    const singleSlot = singleSlotResources.includes(key);
    const preemption = singleSlot && kind !== 'owner' ? new AbortController() : undefined;
    // A queued call starts from whatever call freed the slot, so it carries
    // its own model clocks with it (otherwise its output refreshed the clocks
    // of the call before it). And a call waiting for the slot is waiting on
    // work that is moving: the running call's output also counts as progress
    // for every call queued behind it, so a waiter's no-progress clock stops
    // only when the model itself stalls (1.5 test-mac canary, 24 Nov 2026:
    // private answers queued behind judge calls were stopped at 60 s with
    // nothing wrong). A running call that stalls has its own idle limit,
    // which frees the slot.
    const progress = currentModelProgress();
    const shared = (model: string): void => {
      progress?.(model);
      for (const task of pending.tasks) task.progress?.(model);
    };
    pending.tasks.push({
      priority: kind === 'owner' ? 0 : kind === 'background' ? 1 : 2,
      limit: singleSlot ? 1 : Math.max(1, Math.floor(limit)),
      queuedAt: Date.now(),
      ...(preemption ? { preemption } : {}),
      ...(progress ? { progress } : {}),
      run: async () => {
        const leased = () => runWithModelProgress(shared, () => lease(key, () => work(preemption?.signal)));
        try {
          resolve(await runAtLocalInferencePriority(kind, leased));
        } catch (error) {
          reject(preemption?.signal.aborted ? preemption.signal.reason : error);
        }
      },
    });
    if (kind === 'owner' && pending.running.length > 0) {
      // Close the running lower-priority request at the slot. The owner is
      // already queued and starts first once the canceled request unwinds.
      for (const task of pending.running) task.preemption?.abort(new LocalModelPreempted());
      notifyBusy(key);
    }
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
      const coordinate = <R>(work: (signal?: AbortSignal) => Promise<R>, signal?: AbortSignal, limit = options.concurrency ?? 1): Promise<R> => {
        if (signal?.aborted) return Promise.reject(signal.reason);
        const guards = localInferenceGuards?.getStore() ?? [];
        const checked = async (preempted?: AbortSignal): Promise<R> => {
          const active = signal && preempted ? AbortSignal.any([signal, preempted]) : signal ?? preempted;
          const tagKey = options.tag === undefined ? undefined : `${key}\u0000${options.tag}`;
          if (tagKey !== undefined) taggedRunning.set(tagKey, (taggedRunning.get(tagKey) ?? 0) + 1);
          try {
            active?.throwIfAborted();
            for (const guard of guards) {
              try { await guard(); } catch (error) {
                active?.throwIfAborted();
                throw error;
              }
            }
            active?.throwIfAborted();
            return await work(active);
          } finally {
            if (tagKey !== undefined) taggedRunning.set(tagKey, (taggedRunning.get(tagKey) ?? 1) - 1);
          }
        };
        return options.serialize === false ? lease(key, checked) : dispatch(key, checked, limit);
      };
      return { ...model,
        // Probes and priming use the same slot as completions, exclusively.
        ...(model.prepareSniffer ? { prepareSniffer: (signal?: AbortSignal) => coordinate(active => model.prepareSniffer!(active), signal, 1) } : {}),
        complete: request => coordinate(active => model.complete(active && active !== request.signal ? { ...request, signal: active } : request), request.signal),
      };
    },
  };
}
export type LocalModelActivity = ReturnType<typeof createLocalModelActivity>;
