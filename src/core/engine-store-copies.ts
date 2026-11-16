/**
 * What an `olympus engine install` that replaces a running version (#1639) and `olympus worker upgrade` keep of the
 * data: with the engine stopped, the whole data root is set aside (core/data-root-snapshot.ts). A failed health proof
 * puts it back before the previous version starts; a healthy one removes it. Without this, a failed upgrade across a
 * schema change that is not additive started the previous build on stores it refuses.
 */
import { removeRecordedSchemaBackups } from './boot-progress.ts';
import { commitDataRootSnapshot, putDataRootBack, snapshotDataRoot, updateInFlightSince, type DataRootDeps } from './data-root-snapshot.ts';
import { DataOwnerBusyError, withNoEngineProcess } from './data-owner-lock.ts';
import { OperationError } from './operation-error.ts';
import type { LayoutEnv } from './olympus-layout.ts';
import { putBackManifest } from './put-back-manifest.ts';

/**
 * How long the copy and the put-back wait for the engine that was stopped to let go of its data. A stop the service
 * manager reports done is not a stopped process: launchd's bootout returns while the engine is still shutting down, and on
 * the Mac forced-failure leg (run 43736059061, 15 Nov 2026) the stopping new version opened a store the put-back had just
 * restored and migrated it again, so the restored 1.4.4 refused it. The locks are held until the last engine process exits.
 */
export const ENGINE_STORES_OWNER_WAIT_MS = 60_000;

/** Runs `step` once no Olympus process owns the data, holding that until it returns: one rule for Linux and the Mac, and for `olympus worker upgrade`. */
export function withStoppedEngine<T>(env: LayoutEnv, what: string, step: () => T, waitMs: number = ENGINE_STORES_OWNER_WAIT_MS): T {
  try {
    return withNoEngineProcess(env, step, waitMs);
  } catch (error) {
    if (!(error instanceof DataOwnerBusyError)) throw error;
    throw new OperationError('config_error', `The engine was stopped, but an Olympus process still owns its data after ${Math.round(waitMs / 1000)} s, so its stores were not ${what}.`, 'Run olympus engine stop, then run the installer again. Nothing was changed.');
  }
}

/** With the engine stopped: set the whole data root aside (core/data-root-snapshot.ts). Throws, changing nothing that stays, when it cannot. */
export function copyEngineStores(env: LayoutEnv, options: { log?: (line: string) => void; ownerWaitMs?: number; deps?: DataRootDeps } = {}): void {
  withStoppedEngine(env, 'copied', () => {
    snapshotDataRoot(env, { ...(options.log ? { log: options.log } : {}), ...(options.deps ? { deps: options.deps } : {}) });
  }, options.ownerWaitMs ?? ENGINE_STORES_OWNER_WAIT_MS);
}

/** With the new version stopped: put the data root back as it was before the update. Returns what the owner is told. */
export function restoreEngineStores(env: LayoutEnv, options: { ownerWaitMs?: number; log?: (line: string) => void; deps?: DataRootDeps } = {}): string[] {
  if (updateInFlightSince(env) === undefined) return [];
  // The install log keeps what the put-back worked from, before and after, so a failed rollback explains itself.
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  return withStoppedEngine(env, 'put back', () => {
    log(putBackManifest(env, 'before put-back'));
    const told = putDataRootBack(env, options.deps ? { deps: options.deps } : {});
    log(putBackManifest(env, 'after put-back'));
    return told;
  }, options.ownerWaitMs ?? ENGINE_STORES_OWNER_WAIT_MS);
}

/** The new version proved healthy: the copy goes, and any failed root an earlier update left. Returns what was removed. */
export function commitEngineStores(env: LayoutEnv): string[] {
  try {
    const removed = commitDataRootSnapshot(env);
    // Store copies a build from before the whole-root copy left (core/boot-progress.ts): nothing puts them back now.
    removeRecordedSchemaBackups(env);
    return removed;
  } catch {
    // A copy left behind costs disk, which the next commit takes back.
    return [];
  }
}
