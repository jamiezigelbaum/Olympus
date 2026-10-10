import { deleteOlympusData } from '../data-lifecycle.ts';
import {
  ACCOUNT_BOUND_SOURCE_IDS,
  readSourceAccountBindings,
  sourceAccountBindingsPath,
  updateSourceAccountBinding,
  type AccountBoundSourceId,
} from '../core/source-account-binding.ts';

export interface SourceAccountPurgeOutcome {
  sourceId: AccountBoundSourceId;
  status: 'purged' | 'failed';
  removedPaths: number;
}

/**
 * Remove the stored data of every file source a reconnect handed to a
 * different account, before the worker opens any store.
 *
 * This is the same removal `olympus data delete --source` performs (every
 * tier store, its ledger, secret-locations index and sniffer queue, the
 * source's policy file and its media-cache copies), run at the one moment it
 * is safe inside a live install: worker start, with nothing open. The source
 * is unbound afterwards, so its next verified sync binds the new account.
 * A source whose removal fails keeps its marker, and the account guard keeps
 * refusing to sync it.
 */
export function purgeSourcesAwaitingAccountChange(input: {
  registryPath: string | undefined;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}): SourceAccountPurgeOutcome[] {
  if (!input.registryPath) return [];
  const path = sourceAccountBindingsPath(input.registryPath);
  const read = readSourceAccountBindings(path);
  // An unreadable record is not a purge instruction; the guard refuses to sync
  // until it is repaired.
  if (read.kind === 'malformed') return [];
  const outcomes: SourceAccountPurgeOutcome[] = [];
  for (const sourceId of ACCOUNT_BOUND_SOURCE_IDS) {
    if (!read.bindings.sources[sourceId]?.purge_required) continue;
    try {
      const result = deleteOlympusData({
        sourceId,
        ...(input.env ? { env: input.env } : {}),
        ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      });
      updateSourceAccountBinding(path, sourceId, () => undefined);
      outcomes.push({ sourceId, status: 'purged', removedPaths: result.removed.length });
    } catch {
      outcomes.push({ sourceId, status: 'failed', removedPaths: 0 });
    }
  }
  return outcomes;
}
