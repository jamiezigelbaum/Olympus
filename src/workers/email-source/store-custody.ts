/**
 * Admission to the worker's stores. Every path that serves or changes indexed
 * data goes through one instance: the worker's HTTP API and the in-process
 * readers (ChatGPT and remote-agent search, private-match probes, watches).
 *
 * A Delete indexed data takes exclusive custody: `fence()` refuses new work,
 * `drain()` waits for the work already admitted, and the fence is held until
 * the supervised restart reopens the stores (the process exiting ends it).
 */
export class StoreReopeningError extends Error {
  readonly code = 'source_stores_reopening';
  constructor() {
    super('Olympus is reopening its stores after indexed data was deleted. Try again in a moment.');
    this.name = 'StoreReopeningError';
  }
}

export interface StoreCustody {
  readonly reopening: boolean;
  readonly inflight: number;
  /** Throws StoreReopeningError while fenced. */
  assertOpen(): void;
  /** Run `work` as admitted: counted while it runs, refused while fenced. */
  admit<T>(work: () => Promise<T>): Promise<T>;
  /** Wrap an async function so every call is admitted and its result withheld if a delete began meanwhile. */
  guard<A extends unknown[], R>(work: (...args: A) => Promise<R>): (...args: A) => Promise<R>;
  /**
   * Wrap an object (or function) so every call is admitted for as long as its
   * result is pending: a call made before the fence that is still reading when
   * a delete begins is counted and waited for; one made after is refused.
   */
  retain<T extends object>(target: T): T;
  /** Called each time the fence goes up (e.g. to drop cached answers built from the stores). */
  onFence(listener: () => void): void;
  fence(): void;
  lift(): void;
  /** Resolves true once nothing admitted is running, false at the timeout. */
  drain(timeoutMs: number): Promise<boolean>;
}

export function createStoreCustody(): StoreCustody {
  let reopening = false;
  let inflight = 0;
  const fenceListeners: Array<() => void> = [];
  const custody: StoreCustody = {
    get reopening() { return reopening; },
    get inflight() { return inflight; },
    assertOpen() { if (reopening) throw new StoreReopeningError(); },
    async admit(work) {
      if (reopening) throw new StoreReopeningError();
      inflight += 1;
      try {
        return await work();
      } finally {
        inflight -= 1;
      }
    },
    guard(work) {
      // Held from start to finish, and re-checked before the result leaves: a
      // result read from stores a delete has since removed is not published.
      return (...args) => custody.admit(async () => {
        const result = await work(...args);
        if (reopening) throw new StoreReopeningError();
        return result;
      });
    },
    retain<T extends object>(target: T): T {
      const call = (fn: (...args: unknown[]) => unknown, thisArg: unknown, args: unknown[]): unknown => {
        if (reopening) throw new StoreReopeningError();
        inflight += 1;
        let pending = false;
        try {
          const result = fn.apply(thisArg, args);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            pending = true;
            return (result as Promise<unknown>).finally(() => { inflight -= 1; });
          }
          return result;
        } finally {
          if (!pending) inflight -= 1;
        }
      };
      if (typeof target === 'function') {
        return new Proxy(target, { apply: (fn, thisArg, args) => call(fn as never, thisArg, args) });
      }
      return new Proxy(target, {
        get(obj, key) {
          const value = Reflect.get(obj, key, obj);
          return typeof value === 'function' ? (...args: unknown[]) => call(value as never, obj, args) : value;
        },
      });
    },
    onFence(listener) { fenceListeners.push(listener); },
    fence() {
      reopening = true;
      for (const listener of fenceListeners) {
        try { listener(); } catch { /* a listener must not keep the delete from fencing */ }
      }
    },
    lift() { reopening = false; },
    async drain(timeoutMs) {
      const until = Date.now() + timeoutMs;
      while (inflight > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
      return inflight === 0;
    },
  };
  return custody;
}

/**
 * Fail closed for any in-process reader that opens the answer lanes while the
 * stores are fenced (watches, private-evidence checks, probes). Readers that
 * must also be waited for are wrapped with `guard` at their entry point.
 */
export function guardLanes<F extends (...args: never[]) => unknown>(custody: StoreCustody, lanes: F): F {
  const guarded = ((...args: Parameters<F>) => {
    custody.assertOpen();
    const built = lanes(...args) as Record<string, unknown> | undefined;
    if (!built || typeof built !== 'object') return built;
    // Everything on the lanes that reads a store or ledger retains custody per
    // call, so no reader can start before the fence and still be running when
    // the delete unlinks files.
    const retainEach = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
        [key, entry && typeof entry === 'object' ? custody.retain(entry as object) : entry]));
    };
    const out: Record<string, unknown> = { ...built };
    if (built.adapters) out.adapters = retainEach(built.adapters);
    if (built.contentProviders) out.contentProviders = retainEach(built.contentProviders);
    for (const key of ['visibilityGate', 'secretLocations', 'classificationCoverage']) {
      const entry = built[key];
      if (entry && typeof entry === 'object') out[key] = custody.retain(entry as object);
      else if (typeof entry === 'function') out[key] = custody.retain(entry as (...a: unknown[]) => unknown);
    }
    return out;
  }) as F;
  return Object.assign(guarded, lanes);
}
