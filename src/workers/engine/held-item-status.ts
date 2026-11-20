import type { HeldItemStatus } from '../engine-split/snapshot.ts';
import type { ReadCredential } from './runtime/source-lanes.ts';
import { startPacedStatusRecount } from './status-recount.ts';

export interface HeldInventory {
  stores: Array<{
    corpusId: string;
    sourceId: string;
    dbPath: string;
    ledgerPath?: string;
    read: { accountScope: string | null } | { credential: ReadCredential; gmail?: true };
  }>;
  pending: Array<{
    id: string;
    mountBlocked?: boolean;
    stores: readonly string[];
    credential?: ReadCredential;
  }>;
  mountProblems: string[];
  gmailStores: string[];
}

export type HeldSample = {
  observation: HeldItemStatus;
  groups: Array<{ path: string; corpora: HeldItemStatus['counted_scope']; cursor: number; count: number }>;
};

export type HeldPass = { inventory: HeldInventory; observed_at: string; previous?: HeldSample };

export function startHeldItemStatus(options: {
  inventory: () => HeldInventory;
  holds: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  measure?: typeof measureHeldItems;
  log?: (line: string) => void;
}) {
  const now = options.now ?? Date.now;
  let sample: HeldSample | undefined;
  let active: AbortController | undefined;
  let revision = 0;
  const clear = () => { revision++; sample = undefined; };
  const pace = startPacedStatusRecount({
    ...options,
    recount: async () => {
      const started = revision;
      const observed_at = new Date(now()).toISOString();
      const controller = new AbortController();
      active = controller;
      try {
        const next = await (options.measure ?? measureHeldItems)({
          inventory: options.inventory(), observed_at, ...(sample ? { previous: sample } : {}),
        }, controller.signal, () => { if (started === revision) sample = undefined; });
        if (started === revision) sample = next;
      } catch (error) {
        if (started === revision) sample = undefined;
        if (!controller.signal.aborted) throw error;
      } finally {
        active = undefined;
      }
    },
  });
  const closed = () => { clear(); active?.abort(); pace.soon(); };
  return {
    observation: () => sample?.observation,
    soon: pace.soon,
    invalidate: () => { clear(); pace.soon(); },
    closed,
    stop: () => { clear(); pace.stop(); active?.abort(); },
  };
}

export async function measureHeldItems(
  pass: HeldPass,
  signal: AbortSignal,
  scopeChanged: () => void,
  WorkerType = Worker,
): Promise<HeldSample | undefined> {
  signal.throwIfAborted();
  const bundled = import.meta.url.endsWith('.js');
  const worker = new WorkerType(new URL(bundled ? './held-item-worker.js' : './held-item-worker.ts', import.meta.url), { env: process.env as Record<string, string>, smol: true });
  let cancel!: () => void;
  let terminated = false;
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    worker.terminate();
  };
  try {
    return await new Promise<HeldSample | undefined>((resolve, reject) => {
      const failed = () => reject(new Error('Held-item count unavailable'));
      cancel = () => { reject(signal.reason); terminate(); };
      signal.addEventListener('abort', cancel, { once: true });
      worker.addEventListener('close', failed, { once: true });
      worker.onmessageerror = failed;
      worker.onerror = (event) => { event.preventDefault(); failed(); };
      worker.onmessage = ({ data }) => { if (data === 'scope_changed') scopeChanged(); else resolve(data); };
      worker.postMessage(pass);
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    terminate();
  }
}
