/**
 * Settling a messaging account's layout for a pairing (docs/design/source-storage.md,
 * delivery step 4b), from the CLI, which runs minutes before it saves a grant.
 *
 * The CLI does not decide while a worker owns the data. Its environment is not
 * the worker's (an override, the native-capture flag and XDG_DATA_HOME can all
 * differ), and the worker's boot re-placement and adoption decide from the
 * worker's. So:
 * - an account that has an entry follows it;
 * - one that has none is decided by whoever owns the data: this process under
 *   the owner lock when it is free, else the running worker, over its local API
 *   (`pairing-placement`, like the other CLI commands that open stores). A worker
 *   that is starting, or does not answer, makes the pairing refuse and be
 *   retried rather than guess;
 * - a `legacy` outcome is claimed at once: the legacy capture folder is made,
 *   which the placement decision reads as "this account already has files
 *   there", and the registry is read again under its lease. A boot re-placement
 *   that ran in between is followed (and the folder given back); one that runs
 *   later sees the folder and leaves the account where the pairing put it.
 *   Re-placement and pairing therefore cannot disagree.
 */
import { mkdirSync, rmdirSync } from 'node:fs';
import { callWorkerCli, runLocallyOrThroughWorker } from './cli-via-worker.ts';
import { legacyCaptureClaimDir, type LayoutAccountLayout, type LayoutEnv } from './olympus-layout.ts';
import { hasFolderLayout } from './source-placement.ts';
import { DEFAULT_ACCOUNT_SLOT, findRegistryAccount, readSourceRegistry, readSourceRegistryUnderLease, SourceRegistryError } from './source-registry.ts';
import { SourceStorageUnavailableError, placeOwnedAccount, type StorageAccount } from './source-storage.ts';

export interface SettlePairingPlacementOptions {
  /** Test seam: replaces the worker transport. */
  fetchImpl?: typeof fetch;
}

export async function settlePairingPlacement(
  account: StorageAccount,
  env: LayoutEnv,
  options: SettlePairingPlacementOptions = {},
): Promise<LayoutAccountLayout> {
  const slot = account.slot ?? DEFAULT_ACCOUNT_SLOT;
  const entryLayout = (read: typeof readSourceRegistry): LayoutAccountLayout | undefined => {
    const entry = findRegistryAccount(read(env), account.sourceId, slot);
    if (entry !== undefined && entry.state !== 'active') throw new SourceStorageUnavailableError(account.sourceId, slot, entry.state);
    return entry?.layout;
  };

  let layout: LayoutAccountLayout | undefined;
  try {
    layout = entryLayout(readSourceRegistry);
  } catch (error) {
    if (error instanceof SourceRegistryError || error instanceof SourceStorageUnavailableError) throw error;
    // The data folder cannot be worked out (a Linux layout that refuses this environment): nothing is recorded.
    return 'legacy';
  }
  if (layout === undefined) {
    if (!hasFolderLayout(account.sourceId)) return 'legacy';
    layout = await runLocallyOrThroughWorker<LayoutAccountLayout>(
      () => placeOwnedAccount(account, env),
      async () => {
        const answer = await callWorkerCli<{ layout?: unknown }>('pairing-placement', { source_id: account.sourceId }, {
          env,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        return answer.layout === 'folder' ? 'folder' : 'legacy';
      },
      env,
    );
  }
  if (layout !== 'legacy') return layout;

  // Claim the legacy paths, then check the registry once more under its lease.
  const claimDir = legacyCaptureClaimDir(account.sourceId, env);
  const made = claimDir ? mkdirSync(claimDir, { recursive: true, mode: 0o700 }) : undefined;
  const settled = entryLayout(readSourceRegistryUnderLease) ?? 'legacy';
  if (settled === 'folder' && made && claimDir) {
    try {
      rmdirSync(claimDir);
    } catch {
      // Not empty, or already gone: either way it is not ours to remove.
    }
  }
  return settled;
}
