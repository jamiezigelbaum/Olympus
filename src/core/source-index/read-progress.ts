import { AsyncLocalStorage } from 'node:async_hooks';

// Request-local, content-free store batch receipts. Timers are never progress.
// A lane's reporter may also carry began/ended: a read running on a read
// worker is work in progress for as long as its statement runs.
export type SourceIndexReadProgress = (() => void) & { began?: () => void; ended?: () => void };
const progress = new AsyncLocalStorage<SourceIndexReadProgress>();
export function withSourceIndexReadProgress<T>(report: SourceIndexReadProgress, run: () => T): T {
  return progress.run(report, run);
}
export function withoutSourceIndexReadProgress<T>(run: () => T): T {
  return progress.exit(run);
}
export function noteSourceIndexReadProgress(): void {
  const report = progress.getStore();
  if (!report) return;
  report();
}
// The current request's reporter, for an event that happens later outside its
// async context (a queued read leaving the queue).
export function currentSourceIndexReadProgress(): SourceIndexReadProgress | undefined {
  return progress.getStore();
}
