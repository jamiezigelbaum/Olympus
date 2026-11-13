// Ask has priority over store reclamation, including across the engine split.
// Kernel leases disappear on death; the idle timestamp grants no lock and holds no item data.
import { join } from 'node:path';
import { closeSync, openSync, futimesSync, statSync } from 'node:fs';
import { FileLeaseBusyError, withFileLease, withFileLeaseSync } from './file-lease.ts';
import { sharedDataPath } from './olympus-layout.ts';

const probe = { acquireTimeoutMs: 1, pollIntervalMs: 1 };
const target = (name: string) => join(sharedDataPath('engine-run'), `store-reclaim-${name}`);

/** Shared priority is held BEFORE waiting for maintenance to yield. Concurrent Asks coexist. */
export async function withStoreReadPriority<T>(read: () => T | Promise<T>): Promise<T> {
  // Each call owns its lifetime, including nested/background reads that may
  // outlive the request that started them. Shared leases never serialize Asks.
  return withFileLease(target('readers'), async () => {
    // Timestamp only, shared with the background in split-engine installs.
    // Record before waiting for work so an Ask that kills a conversion counts.
    const fd = openSync(target('last-ask'), 'a', 0o600);
    try { const now = new Date(); futimesSync(fd, now, now); } finally { closeSync(fd); }
    return withFileLease(target('work'), async () => read(), { mode: 'shared', pollIntervalMs: 1 });
  }, { mode: 'shared' });
}

/** Non-waiting probe. A waiting Ask is visible even before its read starts. */
export function storeReadHasPriority(): boolean {
  try {
    return withFileLeaseSync(target('readers'), () => false, probe);
  } catch (error) {
    if (error instanceof FileLeaseBusyError) return true;
    throw error;
  }
}

/** Only the background ticker calls this. A busy store/Ask costs no maintenance wait. */
export async function withIdleStoreReclaim<T>(work: () => Promise<T>): Promise<T | undefined> {
  if (storeReadHasPriority()) return undefined;
  try {
    return await withFileLease(target('work'), async () => {
      if (storeReadHasPriority()) return undefined;
      return work();
    }, probe);
  } catch (error) {
    if (error instanceof FileLeaseBusyError) return undefined;
    throw error;
  }
}

/** Time since the last Ask admission, including admissions in another engine process. */
export function storeOwnerIdleMs(now = Date.now()): number {
  try { return Math.max(0, now - statSync(target('last-ask')).mtimeMs); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Number.POSITIVE_INFINITY;
    throw error;
  }
}
