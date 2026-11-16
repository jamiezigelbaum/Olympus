import { AsyncLocalStorage } from 'node:async_hooks';

// Request-local, content-free store batch receipts. Timers are never progress.
const progress = new AsyncLocalStorage<() => void>();
export function withSourceIndexReadProgress<T>(report: () => void, run: () => T): T {
  return progress.run(report, run);
}
export function noteSourceIndexReadProgress(): void {
  const report = progress.getStore();
  if (!report) return;
  report();
}
// The current request's reporter, for an event that happens later outside its
// async context (a queued read leaving the queue).
export function currentSourceIndexReadProgress(): (() => void) | undefined {
  return progress.getStore();
}
