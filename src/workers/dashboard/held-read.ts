/**
 * Dashboard polls share one refresh and can render without waiting for it.
 * The refresh belongs to the front, so a request leaving does not stop it.
 */
export function createDashboardHeldRead<T>(
  refreshMs: number,
  reportError: (error: unknown) => void,
  now = Date.now,
): (load: () => Promise<T>) => { value?: T; at?: number; ageMs?: number } {
  let held: { value: T; at: number } | undefined;
  let inFlight: Promise<void> | undefined;
  let nextRefresh = Number.NEGATIVE_INFINITY;
  return (load) => {
    const at = now();
    if (!inFlight && at >= nextRefresh) {
      inFlight = Promise.resolve().then(load).then((value) => {
        held = { value, at };
      }, reportError).finally(() => {
        nextRefresh = now() + refreshMs;
        inFlight = undefined;
      });
    }
    if (!held) return {};
    const ageMs = Math.max(0, at - held.at);
    return { ...held, ...(inFlight || ageMs >= refreshMs ? { ageMs } : {}) };
  };
}
