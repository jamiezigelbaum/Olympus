// Ask has priority over store reclamation, including across the engine split.
// Kernel leases disappear on death; no stale marker or item data is stored.
import { join } from 'node:path';
import { FileLeaseBusyError, withFileLease, withFileLeaseSync } from './file-lease.ts';
import { sharedDataPath } from './olympus-layout.ts';

const probe = { acquireTimeoutMs: 1, pollIntervalMs: 1 };
const target = (name: string) => join(sharedDataPath('engine-run'), `store-reclaim-${name}`);

/** Shared priority is held BEFORE waiting for maintenance to yield. Concurrent Asks coexist. */
export async function withStoreReadPriority<T>(read: () => T | Promise<T>): Promise<T> {
  // Each call owns its lifetime, including nested/background reads that may
  // outlive the request that started them. Shared leases never serialize Asks.
  return withFileLease(target('readers'), () => withFileLease(target('work'),
    async () => read(), { mode: 'shared', pollIntervalMs: 1 }), { mode: 'shared' });
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
