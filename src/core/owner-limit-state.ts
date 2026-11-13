/** Content-free owner settings and stops. Bun-only (the scheduler store): workers and the engine import it, the Node plugin never does. */
import { existsSync } from 'node:fs';
import { LocalSourceSchedulerStateStore, defaultSourceSchedulerStateDbPath } from '../workers/source-scheduler-state.ts';
import { installLimitStopHooks, invalidateLimitStop, type LimitStop } from './limit-stops.ts';

export type { DailyCallOverride } from './owner-limit-settings.ts';
export { ownerLimitSettingsPath, readJudgeCallOverride, saveJudgeCallOverride, readOwnerLimitOverride, saveOwnerLimitOverride } from './owner-limit-settings.ts';

/** The existing store owns opening, migrations and deterministic closing. */
export function withOwnerLimitStore<T>(use: (store: LocalSourceSchedulerStateStore) => T, dbPath = defaultSourceSchedulerStateDbPath()): T {
  const store = new LocalSourceSchedulerStateStore(dbPath);
  try { return use(store); } finally { store.close(); }
}
export function recordOwnerLimitStop(stop: LimitStop): void {
  withOwnerLimitStore(store => store.reportLimitStop(stop));
}
export function clearOwnerLimitStop(id: string, subject: string): void {
  if (!existsSync(defaultSourceSchedulerStateDbPath())) return;
  withOwnerLimitStore(store => store.clearLimitStop(id, subject));
  invalidateLimitStop(id, subject);
}
/** Worker-only: the scheduler store is Bun's, so the Node plugin never imports this module. */
export const ownerLimitStopHooks = { record: recordOwnerLimitStop, clear: clearOwnerLimitStop };

/** Marker identities are persisted, so recovery also survives an engine restart. */
export function openVeniceCreditPausePaths(): string[] {
  return withOwnerLimitStore(store => store.openLimitStops().filter(stop => stop.id === 'venice.credit').map(stop => stop.subject));
}

// Only worker entrypoints load this store owner; shared transports stay Node-safe.
installLimitStopHooks(ownerLimitStopHooks);
