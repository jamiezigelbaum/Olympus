/**
 * The store copies an `olympus engine install` takes when it replaces a
 * running version (#1639), the same copies `olympus worker upgrade` takes:
 * with the engine stopped, every store is copied and the upgrade is marked in
 * flight, so the new version's boot copies only what this did not and keeps
 * retired state. A failed health proof puts the copies back before the
 * previous version starts; a healthy one removes them. Without this, a
 * failed upgrade across a schema change that is not additive started the
 * previous build on stores it refuses.
 */
import { clearWorkerUpgradeInFlight, markWorkerUpgradeInFlight, readWorkerUpgradeInFlight, removeRecordedSchemaBackups, restoreSchemaBackupsSince } from './boot-progress.ts';
import type { LayoutEnv } from './olympus-layout.ts';
import { copyStoresBeforeUpgrade } from './upgrade-store-copies.ts';

/** With the engine stopped: mark the upgrade in flight, then copy every store. Throws, changing nothing that stays, when it cannot. */
export function copyEngineStores(env: LayoutEnv, options: { bunBin?: string; log?: (line: string) => void } = {}): void {
  markWorkerUpgradeInFlight(env, new Date().toISOString());
  try {
    const copied = copyStoresBeforeUpgrade(env, options);
    if (copied.stores > 0) options.log?.(`Copied ${copied.stores} stores in ${Math.round(copied.ms / 1000)} s.`);
  } catch (error) {
    clearWorkerUpgradeInFlight(env);
    throw error;
  }
}

/** With the new version stopped: put back what was copied since the mark. Returns the stores put back. */
export function restoreEngineStores(env: LayoutEnv): string[] {
  const startedAt = readWorkerUpgradeInFlight(env);
  if (startedAt === undefined) return [];
  const restored = startedAt === '' ? [] : restoreSchemaBackupsSince(env, Date.parse(startedAt));
  clearWorkerUpgradeInFlight(env);
  return restored;
}

/** The new version proved healthy: the mark goes first, then every recorded copy. */
export function commitEngineStores(env: LayoutEnv): void {
  if (readWorkerUpgradeInFlight(env) === undefined) return;
  clearWorkerUpgradeInFlight(env);
  try {
    removeRecordedSchemaBackups(env);
  } catch {
    // A copy left behind costs disk, which the next commit takes back.
  }
}
