import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { writePrivateFileAtomic } from '../core/atomic-file.ts';

export interface IdleEmbeddingSweep {
  key: string;
  at: number;
  inventory: Record<string, number>;
}

/** Rebuildable counts beside the store, kept out of its SQLite transactions. */
export const EMBEDDING_SWEEP_IDLE_SUFFIX = '.embedding-sweep-idle.json';

// The scheduler spreads these fields into its counts-only log. Validate the
// names as well as the numbers before replaying a receipt from disk.
const INVENTORY_FIELDS = [
  'pending_chunks', 'eligible_chunks', 'skipped_held_chunks', 'skipped_moving_chunks',
  'skipped_hidden_chunks', 'skipped_metadata_chunks', 'skipped_failed_chunks', 'skipped_out_of_scope_chunks',
  'skipped_private_tier_chunks', 'skipped_retired_chunks', 'inventory_complete', 'inventory_ms',
] as const;

export async function readEmbeddingSweepIdle(path: string): Promise<Map<string, IdleEmbeddingSweep>> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) return new Map();
      const entries: unknown = JSON.parse(await file.readFile('utf8'));
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return new Map();
      return new Map(Object.entries(entries).filter((entry): entry is [string, IdleEmbeddingSweep] => isIdleSweep(entry[1])));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[olympus:embedding-sweep] idle state unreadable; walking store');
    }
    return new Map();
  }
}

function isIdleSweep(value: unknown): value is IdleEmbeddingSweep {
  if (!value || typeof value !== 'object') return false;
  const { key, at, inventory } = value as Partial<IdleEmbeddingSweep>;
  return typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)
    && typeof at === 'number' && Number.isSafeInteger(at) && at > 0
    && inventory?.inventory_complete === 1 && inventory.skipped_failed_chunks === 0
    && Object.keys(inventory).length === INVENTORY_FIELDS.length
    && INVENTORY_FIELDS.every((field) => {
      const count = inventory[field];
      return count !== undefined && Number.isSafeInteger(count) && count >= 0;
    });
}

export async function writeEmbeddingSweepIdle(path: string, entries: ReadonlyMap<string, IdleEmbeddingSweep>): Promise<void> {
  try {
    await writePrivateFileAtomic(path, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    console.warn('[olympus:embedding-sweep] idle state could not be saved');
  }
}
