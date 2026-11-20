import { join } from 'node:path';
import { fileLeaseHeld, holdSharedFileLease } from './file-lease.ts';
import { sharedDataPath, type LayoutEnv } from './olympus-layout.ts';

const leasePath = (env?: LayoutEnv): string => join(sharedDataPath('engine-run', env), 'owner-ask');

/** Only the split front's owner-question activity takes this shared lease. */
export async function holdOwnerAsk(env?: LayoutEnv, signal?: AbortSignal): Promise<() => void> {
  return holdSharedFileLease(leasePath(env), signal);
}

/** The kernel drops the lease on front exit, including SIGKILL. */
export function ownerAskHeld(env?: LayoutEnv): boolean {
  return fileLeaseHeld(leasePath(env));
}

/** Hot window loops reuse one probe for 100 ms to avoid opening SQLite on each turn. */
export function createOwnerAskProbe(options: { env?: LayoutEnv; onFailure?: () => void } = {}): () => boolean {
  let nextProbeAt = 0;
  let held = false;
  return () => {
    const now = performance.now();
    if (now >= nextProbeAt) {
      nextProbeAt = now + 100;
      try {
        held = ownerAskHeld(options.env);
      } catch {
        // The command mark still covers this question when the lease is unavailable.
        held = false;
        options.onFailure?.();
      }
    }
    return held;
  };
}
