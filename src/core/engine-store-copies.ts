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
import { DataOwnerBusyError, withDataOwnerLock } from './data-owner-lock.ts';
import { OperationError } from './operation-error.ts';
import type { LayoutEnv } from './olympus-layout.ts';
import { copyStoresBeforeUpgrade } from './upgrade-store-copies.ts';

/**
 * How long the copy and the put-back wait for the engine that was stopped to let go of its data. A stop the service
 * manager reports done is not a stopped process: launchd's bootout returns while the engine is still shutting down, and on
 * the Mac forced-failure leg (run 43736059061, 15 Nov 2026) the stopping new version opened a store the put-back had just
 * restored and migrated it again, so the restored 1.4.4 refused it. The owner lock is held until the last store owner exits.
 */
export const ENGINE_STORES_OWNER_WAIT_MS = 60_000;

/** Runs `step` once no Olympus process owns the data, holding that until it returns: one rule for Linux and the Mac. */
function withStoppedEngine<T>(env: LayoutEnv, what: string, step: () => T, waitMs: number): T {
  try {
    return withDataOwnerLock(env, step, { waitMs });
  } catch (error) {
    if (!(error instanceof DataOwnerBusyError)) throw error;
    throw new OperationError('config_error', `The engine was stopped, but an Olympus process still owns its data after ${Math.round(waitMs / 1000)} s, so its stores were not ${what}.`, 'Run olympus engine stop, then run the installer again. Nothing was changed.');
  }
}

/** With the engine stopped: mark the upgrade in flight, then copy every store. Throws, changing nothing that stays, when it cannot. */
export function copyEngineStores(env: LayoutEnv, options: { bunBin?: string; log?: (line: string) => void; ownerWaitMs?: number } = {}): void {
  withStoppedEngine(env, 'copied', () => {
    markWorkerUpgradeInFlight(env, new Date().toISOString());
    try {
      const copied = copyStoresBeforeUpgrade(env, options);
      if (copied.stores > 0) options.log?.(`Copied ${copied.stores} stores in ${Math.round(copied.ms / 1000)} s.`);
    } catch (error) {
      clearWorkerUpgradeInFlight(env);
      throw error;
    }
  }, options.ownerWaitMs ?? ENGINE_STORES_OWNER_WAIT_MS);
}

/** With the new version stopped: put back what was copied since the mark. Returns the stores put back. */
export function restoreEngineStores(env: LayoutEnv, options: { ownerWaitMs?: number } = {}): string[] {
  const startedAt = readWorkerUpgradeInFlight(env);
  if (startedAt === undefined) return [];
  return withStoppedEngine(env, 'put back', () => {
    const restored = startedAt === '' ? [] : restoreSchemaBackupsSince(env, Date.parse(startedAt));
    clearWorkerUpgradeInFlight(env);
    return restored;
  }, options.ownerWaitMs ?? ENGINE_STORES_OWNER_WAIT_MS);
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
