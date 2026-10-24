/**
 * The storage service: the only code that constructs an account's stores and
 * tier sidecars (docs/design/source-storage.md, "Storage service").
 *
 * Every open reads the account registry first. An account whose state is not
 * `active` (being deleted, or deleted) is never opened: the caller gets
 * `SourceStorageUnavailableError`, the same answer as a lane that is not
 * mounted, and never a stand-in store. So is an account whose files are part
 * way through the boot migration (core/source-account-migration.ts): its plan,
 * not its layout, says where they are. Paths are the caller's, resolved by the
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
 * The entry is recorded before the account's FIRST file, whichever file that
 * is. A store open does it, and so does the open of a tier ledger, secret
 * index or sniffer that comes first, and `recordAccountPlacement` does it for
 * raw state written without any store (an archive import request, the X
 * reconcile state, the local files watch folder). An account whose files sit
 * in its folder while the registry is still schema 1 would be invisible to a
 * step-3 build, which would then place it at the legacy paths.
 *
 * No instance cache: callers share the objects they open, as before.
 */
import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeSqliteStore } from './sqlite-store.ts';
import { SecretLocationsIndex } from '../workers/classification/secret-locations.ts';
import { TierSnifferStore } from '../workers/classification/sniffer-store.ts';
import { TierLedger, type TierLedgerOptions } from '../workers/classification/tier-ledger.ts';
import {
  LocalConnectorStore,
  TIER_SET_BINDING_CONNECTOR_ID,
  TIER_SET_BINDING_RUN_ID,
  type LocalConnectorStoreOptions,
} from '../workers/connector-store/local-index.ts';
import type { LayoutAccountLayout, LayoutEnv } from './olympus-layout.ts';
import { decideAccountLayout, hasFolderLayout, isInsideAccountFolder, storageAccountForCorpus } from './source-placement.ts';
import {
  DEFAULT_ACCOUNT_SLOT,
  findRegistryAccount,
  readSourceRegistry,
  SourceRegistryError,
  sourceAccountMovePending,
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

/** Why an account may not be opened: it is being deleted or was, or its files are being moved. */
export type SourceStorageUnavailableState = Exclude<SourceRegistryAccountState, 'active'> | 'moving';

export class SourceStorageUnavailableError extends Error {
  readonly code = 'source_storage_unavailable';
  readonly sourceId: string;
  readonly slot: string;
  readonly state: SourceStorageUnavailableState;

  constructor(sourceId: string, slot: string, state: SourceStorageUnavailableState) {
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
    if (!entry?.corpus_ids.includes(options.corpusId)) adopt(env, account.sourceId, slot, options.dbPath, options.corpusId);
  }
  return new LocalConnectorStore(options);
}

// A sidecar can be the first file of an account: a tiered set opens its ledger
// before its stores.
export function openTierLedger(account: StorageAccount, options: TierLedgerOptions, env: LayoutEnv = process.env): TierLedger {
  placeSidecar(env, account, options.dbPath);
  return new TierLedger(options);
}

export function openSecretLocations(
  account: StorageAccount,
  options: ConstructorParameters<typeof SecretLocationsIndex>[0],
  env: LayoutEnv = process.env,
): SecretLocationsIndex {
  placeSidecar(env, account, options.dbPath, options.readOnly);
  return new SecretLocationsIndex(options);
}

export function openTierSniffer(
  account: StorageAccount,
  options: ConstructorParameters<typeof TierSnifferStore>[0],
  env: LayoutEnv = process.env,
): TierSnifferStore {
  placeSidecar(env, account, options.dbPath, options.readOnly);
  return new TierSnifferStore(options);
}

/**
 * Record the account's placement, and with it the registry's schema, before
 * the first file of it is written, for a writer that opens no store: raw
 * state (`raw/` of the account's folder) such as an archive import request,
 * the X reconcile state or the local files watch folder. Call it before the
 * path's folder is created. Like adoption it does nothing while adoption is
 * off (the registry is not even read), for an account that already has an
 * entry, and for `:memory:`; it records `legacy` (no schema change) for an
 * account the decision keeps at the legacy paths, or for a path outside the
 * folder. An unreadable registry fails the call, as it fails an open.
 */
export function recordAccountPlacement(account: StorageAccount, path: string, env: LayoutEnv = process.env): void {
  if (!adoptionEnabled) return;
  placeBeforeFirstFile(env, readSourceRegistry(env), account, path);
}

/**
 * Settle an account's layout, recording it when the registry has no entry for
 * it, from the same decision adoption makes. For a caller that owns the data and
 * so is the only one deciding: the CLI holding the owner lock with no worker
 * running, or the worker itself, answering the CLI from its own environment
 * (`pairing-placement` in workers/cli-operations.ts; core/pairing-placement.ts
 * is the CLI's side). An account that has an entry follows it.
 *
 * An unreadable registry fails the call, as it fails an open; so does an
 * account being deleted. A data folder that cannot be worked out records
 * nothing, and the account is `legacy`.
 */
export function placeOwnedAccount(account: StorageAccount, env: LayoutEnv = process.env): LayoutAccountLayout {
  const slot = account.slot ?? DEFAULT_STORAGE_SLOT;
  const existing = (registry: SourceRegistry): LayoutAccountLayout | undefined => {
    assertOpenable(registry, account.sourceId, slot);
    return findRegistryAccount(registry, account.sourceId, slot)?.layout;
  };
  let layout: LayoutAccountLayout | undefined;
  try {
    layout = existing(readSourceRegistry(env));
  } catch (error) {
    if (error instanceof SourceRegistryError || error instanceof SourceStorageUnavailableError) throw error;
    // The data folder cannot be worked out (a Linux layout that refuses this environment).
    return 'legacy';
  }
  if (layout !== undefined || !hasFolderLayout(account.sourceId)) return layout ?? 'legacy';
  updateSourceRegistry(env, (registry) => {
    layout = existing(registry);
    if (layout !== undefined) return;
    layout = decideAccountLayout(account.sourceId, env).layout;
    registry.accounts.push({
      source_id: account.sourceId,
      slot,
      state: 'active',
      layout,
      corpus_ids: [],
      created_at: new Date().toISOString(),
    });
  });
  return layout ?? 'legacy';
}

/**
 * Worker boot, under the owner lock and before anything mounts: an account the
 * registry lists as `legacy` that holds nothing yet is placed in a folder
 * instead, so one recorded before its source had a folder layout (or before a
 * pin was lifted) is not stuck at the legacy paths. Nothing moves, so it is not
 * behind the migration switch. Returns the source ids it re-placed.
 *
 * It must never hide an account's files, so all of these must hold, checked
 * again under the registry lease:
 * - the entry is `active` and lists no corpus: no store was ever opened for
 *   the account, so none exists at a path this process cannot see (a store's
 *   path is not recorded, and an override lifted since could have placed it
 *   anywhere);
 * - the placement decision says `folder`: no pin (env override, mount,
 *   native ownership, a capture grant that names a session path or cannot be
 *   read), no file or capture folder at any legacy location, and every one of
 *   them can be looked at.
 */
export function replaceEmptyLegacyAccounts(env: LayoutEnv = process.env): string[] {
  const eligible = (account: SourceRegistry['accounts'][number]): boolean =>
    account.state === 'active'
    && account.layout === 'legacy'
    // A move under way (the boot migration creates an entry that lists no corpus,
    // and a crash after its last rename leaves no file at a legacy location) is
    // the migration's to end: a re-placement here would make an account that a
    // roll-back then restores to the old places a folder with nothing in it.
    && !sourceAccountMovePending(account)
    && account.corpus_ids.length === 0
    && hasFolderLayout(account.source_id)
    && decideAccountLayout(account.source_id, env).layout === 'folder';
  if (!readSourceRegistry(env).accounts.some(eligible)) return [];
  const replaced: string[] = [];
  updateSourceRegistry(env, (registry) => {
    for (const account of registry.accounts) {
      if (!eligible(account)) continue;
      account.layout = 'folder';
      replaced.push(account.source_id);
    }
  });
  return replaced;
}

function placeSidecar(env: LayoutEnv, account: StorageAccount, path: string, readOnly?: boolean): void {
  const registry = readSourceRegistry(env);
  assertOpenable(registry, account.sourceId, account.slot ?? DEFAULT_STORAGE_SLOT);
  if (readOnly !== true) placeBeforeFirstFile(env, registry, account, path);
}

function placeBeforeFirstFile(env: LayoutEnv, registry: SourceRegistry, account: StorageAccount, path: string): void {
  const slot = account.slot ?? DEFAULT_STORAGE_SLOT;
  if (!adoptionEnabled || path === ':memory:') return;
  if (findRegistryAccount(registry, account.sourceId, slot)) return;
  adopt(env, account.sourceId, slot, path);
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
  const entry = findRegistryAccount(registry, account.sourceId, account.slot ?? DEFAULT_STORAGE_SLOT);
  const state = unavailableState(entry);
  return state === undefined ? undefined : unavailableStateReason(state);
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

function unavailableStateReason(state: SourceStorageUnavailableState): string {
  if (state === 'moving') return 'its files are being moved into its folder';
  return state === 'deleting' ? 'its data is being deleted' : 'its data was deleted';
}

function unavailableState(entry: SourceRegistry['accounts'][number] | undefined): SourceStorageUnavailableState | undefined {
  if (entry === undefined) return undefined;
  if (entry.state !== 'active') return entry.state;
  return sourceAccountMovePending(entry) ? 'moving' : undefined;
}

function assertOpenable(registry: SourceRegistry, sourceId: string, slot: string): void {
  const state = unavailableState(findRegistryAccount(registry, sourceId, slot));
  if (state !== undefined) throw new SourceStorageUnavailableError(sourceId, slot, state);
}

/** Record the account (and the corpus, when a store's open names one) under the registry lease. */
function adopt(env: LayoutEnv, sourceId: string, slot: string, dbPath: string, corpusId?: string): void {
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
        corpus_ids: corpusId === undefined ? [] : [corpusId],
        created_at: new Date().toISOString(),
      });
    } else if (corpusId !== undefined && !entry.corpus_ids.includes(corpusId)) {
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

// ---------------------------------------------------------------------------
// What the boot migration (core/source-account-migration.ts) does to a store
// file it has just moved. It holds the owner lock and nothing is mounted, so
// these are the only opens, and they sit here because this is the only place
// a store file is opened (test/store-open-guard.test.ts).

/** Whether a store file opens read-only and its schema reads. Creates and changes nothing but SQLite's own `-shm`. */
export function storeFileReads(path: string): boolean {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false });
    db.exec('PRAGMA busy_timeout = 10000;');
    db.query('SELECT count(*) AS n FROM sqlite_master').get();
    return true;
  } catch {
    return false;
  } finally {
    if (db) closeSqliteStore(db, { checkpoint: false });
  }
}

/**
 * `PRAGMA quick_check` on a store file, read-only: `ok`, or `damaged` for anything else, a file that will not open
 * included. It is synchronous and cannot be interrupted, so the caller bounds it by size beforehand.
 */
export function storeFileQuickCheck(path: string): 'ok' | 'damaged' {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false });
    db.exec('PRAGMA busy_timeout = 10000;');
    const rows = db.query('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    return rows.length === 1 && Object.values(rows[0]!)[0] === 'ok' ? 'ok' : 'damaged';
  } catch {
    return 'damaged';
  } finally {
    if (db) closeSqliteStore(db, { checkpoint: false });
  }
}

/**
 * A store bound to a tiered set keeps the set ledger's path in its binding
 * (`sync_runs`, see `LocalConnectorStore.tierSetBinding`), and fails closed
 * when the path leads nowhere. `map` is given that path and returns the one
 * to record, or undefined to leave it. Returns whether the binding changed.
 * The ledger's identity is kept. The store is opened for writing only when the
 * binding has to change, so a store without one is not touched, its WAL not
 * folded into the file.
 */
export function repointTierSetBinding(path: string, map: (ledgerPath: string) => string | undefined): boolean {
  const readBinding = (db: Database): Record<string, unknown> | undefined => {
    let row: { cursor: string | null } | null;
    try {
      row = db.query('SELECT cursor FROM sync_runs WHERE sync_run_id = ? AND connector_id = ?')
        .get(TIER_SET_BINDING_RUN_ID, TIER_SET_BINDING_CONNECTOR_ID) as { cursor: string | null } | null;
    } catch (error) {
      if (/no such table/i.test(String(error))) return undefined; // Not a connector store: it binds to nothing.
      throw error;
    }
    if (!row?.cursor) return undefined;
    try {
      const binding = JSON.parse(row.cursor) as Record<string, unknown>;
      return typeof binding.ledgerPath === 'string' ? binding : undefined;
    } catch {
      return undefined; // Unreadable already: the store fails closed on it, moved or not.
    }
  };
  let next: string | undefined;
  let reader: Database | undefined;
  try {
    reader = new Database(path, { readonly: true, create: false });
    reader.exec('PRAGMA busy_timeout = 10000;');
    const binding = readBinding(reader);
    next = binding ? map(binding.ledgerPath as string) : undefined;
    if (next === undefined || next === binding!.ledgerPath) return false;
  } finally {
    if (reader) closeSqliteStore(reader, { checkpoint: false });
  }
  let db: Database | undefined;
  try {
    db = new Database(path, { readwrite: true, create: false });
    db.exec('PRAGMA busy_timeout = 10000;');
    const binding = readBinding(db);
    if (!binding) return false;
    db.query('UPDATE sync_runs SET cursor = ? WHERE sync_run_id = ? AND connector_id = ?')
      .run(JSON.stringify({ ...binding, ledgerPath: next }), TIER_SET_BINDING_RUN_ID, TIER_SET_BINDING_CONNECTOR_ID);
    return true;
  } finally {
    if (db) closeSqliteStore(db, { checkpoint: false });
  }
}

export const __sourceStorageTestHooks = {
  disableAdoption(): void {
    adoptionEnabled = false;
  },
};
