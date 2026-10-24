/**
 * The storage service: the only code that constructs an account's stores and
 * tier sidecars (docs/design/source-storage.md, "Storage service").
 *
 * Every open reads the account registry first. An account whose state is not
 * `active` (being deleted, or deleted) is never opened: the caller gets
 * `SourceStorageUnavailableError`, the same answer as a lane that is not
 * mounted, and never a stand-in store. Paths are the caller's, resolved by the
 * account's layout (core/olympus-layout.ts, core/source-placement.ts); nothing
 * here moves a file.
 *
 * Adoption: the worker turns it on once at boot. From then on a writable open
 * of an account with no registry entry records one, before the store's first
 * file exists: `layout: 'folder'` for a new account that core/source-placement.ts
 * places in a folder, `'legacy'` (the files at today's paths) for every other,
 * and an open of a corpus the entry does not list yet adds it. Read-only
 * opens, and every open while adoption is off (the CLI, scripts, tests),
 * never write the registry; they resolve the entry, or the same decision.
 *
 * No instance cache: callers share the objects they open, as before.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { SecretLocationsIndex } from '../workers/classification/secret-locations.ts';
import { TierSnifferStore } from '../workers/classification/sniffer-store.ts';
import { TierLedger, type TierLedgerOptions } from '../workers/classification/tier-ledger.ts';
import { LocalConnectorStore, type LocalConnectorStoreOptions } from '../workers/connector-store/local-index.ts';
import type { LayoutAccountLayout, LayoutEnv } from './olympus-layout.ts';
import { decideAccountLayout, isInsideAccountFolder, storageAccountForCorpus } from './source-placement.ts';
import {
  DEFAULT_ACCOUNT_SLOT,
  findRegistryAccount,
  readSourceRegistry,
  updateSourceRegistry,
  type SourceRegistry,
  type SourceRegistryAccountState,
} from './source-registry.ts';

export { storageAccountForCorpus };

/** One connected account of a source. Every source has one slot today. */
export interface StorageAccount {
  sourceId: string;
  slot?: string;
}

export const DEFAULT_STORAGE_SLOT = DEFAULT_ACCOUNT_SLOT;

export class SourceStorageUnavailableError extends Error {
  readonly code = 'source_storage_unavailable';
  readonly sourceId: string;
  readonly slot: string;
  readonly state: Exclude<SourceRegistryAccountState, 'active'>;

  constructor(sourceId: string, slot: string, state: Exclude<SourceRegistryAccountState, 'active'>) {
    const account = slot === DEFAULT_STORAGE_SLOT ? sourceId : `${sourceId} (account ${slot})`;
    super(`${account} is not available: ${unavailableStateReason(state)}.`);
    this.name = 'SourceStorageUnavailableError';
    this.sourceId = sourceId;
    this.slot = slot;
    this.state = state;
  }
}

let adoptionEnabled = false;

/** Record accounts on their first writable open. The worker's `main()` calls this once, before any lane mounts. */
export function enableSourceRegistryAdoption(): void {
  adoptionEnabled = true;
}

export function openConnectorStore(
  account: StorageAccount,
  options: LocalConnectorStoreOptions,
  env: LayoutEnv = process.env,
): LocalConnectorStore {
  const slot = account.slot ?? DEFAULT_STORAGE_SLOT;
  const registry = readSourceRegistry(env);
  assertOpenable(registry, account.sourceId, slot);
  if (adoptionEnabled && options.readOnly !== true) {
    const entry = findRegistryAccount(registry, account.sourceId, slot);
    if (!entry?.corpus_ids.includes(options.corpusId)) adopt(env, account.sourceId, slot, options.corpusId, options.dbPath);
  }
  return new LocalConnectorStore(options);
}

export function openTierLedger(account: StorageAccount, options: TierLedgerOptions, env: LayoutEnv = process.env): TierLedger {
  assertOpenable(readSourceRegistry(env), account.sourceId, account.slot ?? DEFAULT_STORAGE_SLOT);
  return new TierLedger(options);
}

export function openSecretLocations(
  account: StorageAccount,
  options: ConstructorParameters<typeof SecretLocationsIndex>[0],
  env: LayoutEnv = process.env,
): SecretLocationsIndex {
  assertOpenable(readSourceRegistry(env), account.sourceId, account.slot ?? DEFAULT_STORAGE_SLOT);
  return new SecretLocationsIndex(options);
}

export function openTierSniffer(
  account: StorageAccount,
  options: ConstructorParameters<typeof TierSnifferStore>[0],
  env: LayoutEnv = process.env,
): TierSnifferStore {
  assertOpenable(readSourceRegistry(env), account.sourceId, account.slot ?? DEFAULT_STORAGE_SLOT);
  return new TierSnifferStore(options);
}

/**
 * Why an account's stores may not be opened now, or undefined when they may.
 * An unreadable registry closes every account (it may hold a delete marker).
 */
export function sourceAccountUnavailableReason(account: StorageAccount, env: LayoutEnv = process.env): string | undefined {
  let registry: SourceRegistry;
  try {
    registry = readSourceRegistry(env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const state = findRegistryAccount(registry, account.sourceId, account.slot ?? DEFAULT_STORAGE_SLOT)?.state;
  if (state === undefined || state === 'active') return undefined;
  return unavailableStateReason(state);
}

/** Whether an account's stores may be opened now: the mount decision at worker boot. */
export function isSourceAccountOpenable(account: StorageAccount, env: LayoutEnv = process.env): boolean {
  return sourceAccountUnavailableReason(account, env) === undefined;
}

/** The source that owns a store file, if any. */
export type StoreFileOwner = (dbPath: string) => string | undefined;

/**
 * Finds a store file's owner by the file, not by how its path is spelled. A
 * file that exists matches by device and inode, so a `./`, `..` or symlinked
 * spelling of it finds the same owner; one not created yet matches by its
 * resolved path.
 */
export function storeFileOwnerLookup(owned: Iterable<readonly [dbPath: string, sourceId: string]>): StoreFileOwner {
  const owners = new Map<string, string>();
  for (const [dbPath, sourceId] of owned) owners.set(storeFileKey(dbPath), sourceId);
  return (dbPath) => owners.get(storeFileKey(dbPath));
}

function storeFileKey(dbPath: string): string {
  try {
    const stat = statSync(dbPath);
    return `file:${stat.dev}:${stat.ino}`;
  } catch {
    return `path:${resolve(dbPath)}`;
  }
}

function unavailableStateReason(state: Exclude<SourceRegistryAccountState, 'active'>): string {
  return state === 'deleting' ? 'its data is being deleted' : 'its data was deleted';
}

function assertOpenable(registry: SourceRegistry, sourceId: string, slot: string): void {
  const state = findRegistryAccount(registry, sourceId, slot)?.state;
  if (state !== undefined && state !== 'active') throw new SourceStorageUnavailableError(sourceId, slot, state);
}

function adopt(env: LayoutEnv, sourceId: string, slot: string, corpusId: string, dbPath: string): void {
  updateSourceRegistry(env, (registry) => {
    // Read again under the lease: a delete marked since the first read wins.
    assertOpenable(registry, sourceId, slot);
    const entry = findRegistryAccount(registry, sourceId, slot);
    if (!entry) {
      registry.accounts.push({
        source_id: sourceId,
        slot,
        state: 'active',
        layout: adoptedLayout(env, sourceId, slot, dbPath),
        corpus_ids: [corpusId],
        created_at: new Date().toISOString(),
      });
    } else if (!entry.corpus_ids.includes(corpusId)) {
      entry.corpus_ids.push(corpusId);
    }
  });
}

/**
 * The layout a new entry records, decided before the store's first file
 * exists (core/source-placement.ts). A store that is not inside the folder the
 * decision names was opened at a path of the caller's own, and `folder` would
 * then promise files that are not there: that account is `legacy`.
 */
function adoptedLayout(env: LayoutEnv, sourceId: string, slot: string, dbPath: string): LayoutAccountLayout {
  if (decideAccountLayout(sourceId, env).layout !== 'folder') return 'legacy';
  return isInsideAccountFolder(dbPath, { source_id: sourceId, slot }, env) ? 'folder' : 'legacy';
}

export const __sourceStorageTestHooks = {
  disableAdoption(): void {
    adoptionEnabled = false;
  },
};
