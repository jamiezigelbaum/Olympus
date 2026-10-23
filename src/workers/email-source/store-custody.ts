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
  /** Wrap a function so every call is admitted. */
  guard<A extends unknown[], R>(work: (...args: A) => Promise<R>): (...args: A) => Promise<R>;
  fence(): void;
  lift(): void;
  /** Resolves true once nothing admitted is running, false at the timeout. */
  drain(timeoutMs: number): Promise<boolean>;
}

export function createStoreCustody(): StoreCustody {
  let reopening = false;
  let inflight = 0;
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
      return (...args) => custody.admit(() => work(...args));
    },
    fence() { reopening = true; },
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
    return lanes(...args);
  }) as F;
  return Object.assign(guarded, lanes);
}
