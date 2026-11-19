import { join } from 'node:path';
import { fileLeaseHeld, holdSharedFileLeaseSync } from './file-lease.ts';
import { sharedDataPath, type LayoutEnv } from './olympus-layout.ts';

const leasePath = (env?: LayoutEnv): string => join(sharedDataPath('engine-run', env), 'owner-ask');

/** Only the split front's owner-question activity takes this shared lease. */
export function holdOwnerAsk(env?: LayoutEnv): () => void {
  return holdSharedFileLeaseSync(leasePath(env));
}

/** The kernel drops the lease on front exit, including SIGKILL. */
export function ownerAskHeld(env?: LayoutEnv): boolean {
  return fileLeaseHeld(leasePath(env));
}

/** Hot window loops reuse one probe for 100 ms to avoid opening SQLite on each turn. */
export function createOwnerAskProbe(): () => boolean {
  let nextProbeAt = 0;
  let held = false;
  return () => {
    const now = performance.now();
    if (now >= nextProbeAt) {
      held = ownerAskHeld();
      nextProbeAt = now + 100;
    }
    return held;
  };
}
