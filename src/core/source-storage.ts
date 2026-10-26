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
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { closeSqliteStore } from './sqlite-store.ts';
import { SecretLocationsIndex } from '../workers/classification/secret-locations.ts';
import { TierSnifferStore } from '../workers/classification/sniffer-store.ts';
import { TierLedger, type TierLedgerOptions } from '../workers/classification/tier-ledger.ts';
import { LocalConnectorStore, type LocalConnectorStoreOptions } from '../workers/connector-store/local-index.ts';
import {
  TELEGRAM_SOURCE_ID,
  WHATSAPP_BRIDGE_LOCK_NAME,
  WHATSAPP_SOURCE_ID,
  legacyCaptureClaimDir,
  legacyTelegramSessionBase,
  type LayoutAccountLayout,
  type LayoutEnv,
} from './olympus-layout.ts';
import { tryHoldFileFlock } from './data-owner-lock.ts';
import { isFileLeaseSidecarName, withFileLeaseSync } from './file-lease.ts';
import { decideAccountLayout, hasFolderLayout, isInsideAccountFolder, legacyPinFor, storageAccountForCorpus } from './source-placement.ts';
import { compareProviderAccounts, mergeProviderAccountIds } from './provider-account-identity.ts';
import { placedStoreHolder } from './store-identity.ts';
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
  let registry = readSourceRegistry(env);
  assertOpenable(registry, account.sourceId, slot);
  if (adoptionEnabled && options.readOnly !== true) {
    const entry = findRegistryAccount(registry, account.sourceId, slot);
    if (!entry?.corpus_ids.includes(options.corpusId)) {
      adopt(env, account.sourceId, slot, options.dbPath, options.corpusId);
      registry = readSourceRegistry(env);
    }
  }
  // A store the registry places holds its pictures by who it is, not where its
  // file sits, so renaming it into its account folder needs no media-cache call.
  const mediaHolder = placedStoreHolder({ sourceId: account.sourceId, slot }, options, env, registry);
  return new LocalConnectorStore(mediaHolder ? { ...options, mediaHolder } : options);
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
  const registry = readSourceRegistry(env);
  // Raw state of an account being deleted or moved is not written either: a
  // write between a Delete's mark and the restart would be removed at boot.
  assertOpenable(registry, account.sourceId, account.slot ?? DEFAULT_STORAGE_SLOT);
  placeBeforeFirstFile(env, registry, account, path);
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

/** How old an empty claim folder must be before a boot takes it back: longer than any pairing waits for its helper (ten minutes). */
export const CAPTURE_CLAIM_RECLAIM_AGE_MS = 60 * 60_000;

/**
 * A pairing that settled on the legacy paths claims them by making the legacy
 * capture folder (core/pairing-placement.ts), which the placement decision
 * reads as files already there. One that then failed before its helper wrote
 * anything left that folder empty (or holding only its own lock files), and it
 * kept the account `legacy` for good. Worker boot, under the owner lock and
 * before the re-placement below: such a folder is removed when all of these
 * hold, so the re-placement can then decide as if no pairing had happened:
 * - the account's entry is `active`, `legacy`, lists no corpus and has no move
 *   pending, and nothing pins it (an override, native capture, a capture grant);
 * - the folder is a real folder that holds nothing but the Telegram pairing
 *   lease's files or the WhatsApp bridge's lock file;
 * - no pairing holds those locks now, and the folder has not changed for an
 *   hour (a pairing that runs in another environment, an override of its own,
 *   keeps its lock elsewhere).
 * Returns the source ids whose claim was taken back.
 */
export function reclaimEmptyCaptureClaims(env: LayoutEnv = process.env): string[] {
  const reclaimed: string[] = [];
  let registry: SourceRegistry;
  try {
    registry = readSourceRegistry(env);
  } catch {
    return reclaimed;
  }
  for (const sourceId of [TELEGRAM_SOURCE_ID, WHATSAPP_SOURCE_ID]) {
    const entry = findRegistryAccount(registry, sourceId, DEFAULT_ACCOUNT_SLOT);
    if (!entry || entry.state !== 'active' || entry.layout !== 'legacy' || entry.corpus_ids.length > 0 || sourceAccountMovePending(entry)) continue;
    if (legacyPinFor(sourceId, env)) continue;
    const claim = legacyCaptureClaimDir(sourceId, env);
    if (!claim) continue;
    let stat;
    try {
      stat = lstatSync(claim);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || Date.now() - stat.mtimeMs < CAPTURE_CLAIM_RECLAIM_AGE_MS) continue;
    const leaseTarget = sourceId === TELEGRAM_SOURCE_ID ? `${basename(legacyTelegramSessionBase(env))}.pairing` : undefined;
    let names: string[];
    try {
      names = readdirSync(claim);
    } catch {
      continue;
    }
    const ownLock = (name: string): boolean => (leaseTarget ? isFileLeaseSidecarName(leaseTarget, name) : name === WHATSAPP_BRIDGE_LOCK_NAME);
    if (!names.every(ownLock)) continue;
    if (removeClaimUnderItsLock(claim, ownLock, leaseTarget)) reclaimed.push(sourceId);
  }
  return reclaimed;
}

/**
 * Removes the claim folder's lock files and the folder, holding the lock they
 * make, so no pairing starts in between. Looked at again under the lock (taking
 * a lease makes its journal): anything but lock files keeps the folder.
 */
function removeClaimUnderItsLock(claim: string, ownLock: (name: string) => boolean, leaseTarget: string | undefined): boolean {
  const remove = (): boolean => {
    try {
      const names = readdirSync(claim);
      if (!names.every(ownLock)) return false;
      for (const name of names) rmSync(join(claim, name), { force: true });
      rmdirSync(claim);
      return true;
    } catch {
      return false;
    }
  };
  if (leaseTarget) {
    try {
      return withFileLeaseSync(join(claim, leaseTarget), () => remove(), { acquireTimeoutMs: 1 });
    } catch {
      return false; // A pairing holds it, or it cannot be taken: the claim stands.
    }
  }
  let lock;
  try {
    lock = tryHoldFileFlock(join(claim, WHATSAPP_BRIDGE_LOCK_NAME));
  } catch {
    return false;
  }
  if (!lock) return false;
  try {
    return remove();
  } finally {
    lock.release();
  }
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
  reclaimEmptyCaptureClaims(env);
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

/**
 * What recordProviderAccount found: `recorded` (the entry named no account, or
 * named one for a history the caller saw empty, and now names this one), `same` (it names this one, perhaps by fewer labels, which
 * it now carries too), `different` or `unproven` (it names another, or one this
 * id cannot be matched to, and stays as it was), `no_entry` (nothing to record
 * on).
 */
export type ProviderAccountRecord = 'recorded' | 'same' | 'different' | 'unproven' | 'no_entry';

/**
 * Record which provider account an account's history belongs to
 * (docs/design/source-storage.md, "One account, live and imported"), for whoever
 * first establishes it: the worker once a live source's binding names its
 * account, a Telegram pairing, an import that carries the id. The first value
 * stays; a later one may only add labels, and only when it is the same account.
 * Never creates an entry. Writes nothing unless the entry changes. For a caller
 * that owns the data (the worker, or the CLI under the owner lock), as
 * placeOwnedAccount is. An account being deleted or moved fails the call.
 */
export function recordProviderAccount(
  account: StorageAccount,
  providerAccountId: string,
  env: LayoutEnv = process.env,
  options: {
    /**
     * The caller saw the account hold no item (the account guard, about to let
     * a sync run): the account the entry names has no history here, so it takes
     * this one instead of staying.
     */
    historyEmpty?: boolean;
  } = {},
): ProviderAccountRecord {
  const slot = account.slot ?? DEFAULT_STORAGE_SLOT;
  const decide = (registry: SourceRegistry): { result: ProviderAccountRecord; write?: string } => {
    assertOpenable(registry, account.sourceId, slot);
    const entry = findRegistryAccount(registry, account.sourceId, slot);
    if (!entry) return { result: 'no_entry' };
    const recorded = entry.provider_account_hash;
    if (recorded === undefined) return { result: 'recorded', write: providerAccountId };
    const match = compareProviderAccounts(recorded, providerAccountId);
    if (match !== 'same' && options.historyEmpty === true) return { result: 'recorded', write: providerAccountId };
    if (match !== 'same') return { result: match };
    const merged = mergeProviderAccountIds(recorded, providerAccountId);
    return merged === recorded ? { result: 'same' } : { result: 'same', write: merged };
  };
  let decided = decide(readSourceRegistry(env));
  if (decided.write === undefined) return decided.result;
  updateSourceRegistry(env, (registry) => {
    decided = decide(registry);
    const entry = findRegistryAccount(registry, account.sourceId, slot);
    if (entry && decided.write !== undefined) entry.provider_account_hash = decided.write;
  });
  return decided.result;
}

/**
 * Where an import of a source's history goes:
 * - `same`: into that account, the one the source's entry names (or, once the
 *   owner confirmed it, the one entry the source has);
 * - `new`: the source had no entry, and now has one, naming the import's
 *   account when it carries one; a later connect or pairing joins it;
 * - `unproven`: the entry and the import cannot be matched (one names no
 *   account, or only by labels that cannot decide). The owner confirms in the
 *   import sheet, and the import is asked again with `ownerConfirmed`;
 * - `different`: another account's history; the import stays under
 *   `archive.imports`.
 */
export type ImportAccountMatch = 'same' | 'new' | 'unproven' | 'different';

export interface ImportAccountResolution {
  match: ImportAccountMatch;
  /** The account the import joins (`same`, `new`), or would once confirmed (`unproven`). */
  account?: Required<StorageAccount>;
}

/**
 * Resolve the account an import of `sourceId` joins, by its provider account id
 * when the archive carries one (docs/design/source-storage.md, "One account,
 * live and imported"), recording what it establishes: a new entry, the import's
 * account on an entry that named none once the owner confirmed it, or labels the
 * entry did not have yet. Every source has one account slot today. For a caller
 * that owns the data, as recordProviderAccount is; an account being deleted or
 * moved fails the call.
 */
export function resolveImportAccount(
  sourceId: string,
  importAccountId: string | undefined,
  options: { ownerConfirmed?: boolean; env?: LayoutEnv } = {},
): ImportAccountResolution {
  const env = options.env ?? process.env;
  const account = { sourceId, slot: DEFAULT_STORAGE_SLOT };
  const registry = readSourceRegistry(env);
  assertOpenable(registry, sourceId, account.slot);
  const entry = findRegistryAccount(registry, sourceId, account.slot);
  if (!entry) {
    placeOwnedAccount(account, env);
    if (importAccountId === undefined) return { match: 'new', account };
    // An entry another writer made in between, naming its account, decides.
    const written = recordProviderAccount(account, importAccountId, env);
    if (written === 'different') return { match: 'different' };
    if (written === 'unproven') return { match: 'unproven', account };
    return { match: written === 'same' ? 'same' : 'new', account };
  }
  const recorded = entry.provider_account_hash;
  const match = recorded !== undefined && importAccountId !== undefined
    ? compareProviderAccounts(recorded, importAccountId)
    : 'unproven';
  if (match === 'different') return { match };
  if (match === 'unproven' && options.ownerConfirmed !== true) return { match, account };
  // Proved, or confirmed by the owner: an entry that named no account takes the
  // import's, and one that names it by fewer labels takes the rest.
  if (importAccountId !== undefined && (recorded === undefined || match === 'same')) {
    const written = recordProviderAccount(account, importAccountId, env);
    // Named by another writer since the read above: that account decides, and the owner is asked again.
    if (written === 'different') return { match: 'different' };
    if (written === 'unproven' && recorded === undefined) return { match: 'unproven', account };
  }
  return { match: 'same', account };
}

/**
 * Which account an owner's confirmation was about: the registry account (the
 * incarnation that was created, so a deleted and created-again account is
 * another) and the provider account its history names. Recorded with the
 * confirmation and compared at every pass (`sameImportAccount`), because the
 * account guard may bind other stores over this slot, and a confirmation of
 * one account must never carry to another. Undefined when the source has no
 * entry. An account being deleted or moved fails the call.
 */
export function importAccountIdentity(sourceId: string, env: LayoutEnv = process.env): string | undefined {
  const registry = readSourceRegistry(env);
  assertOpenable(registry, sourceId, DEFAULT_STORAGE_SLOT);
  const entry = findRegistryAccount(registry, sourceId, DEFAULT_STORAGE_SLOT);
  return entry ? JSON.stringify([entry.created_at, entry.provider_account_hash ?? null]) : undefined;
}

/**
 * Whether the account the registry holds now is the one `confirmed` named:
 * the same incarnation, and the same provider account (one that only gained
 * labels is the same; one that was unnamed and is named now, or the reverse,
 * is not, because the owner confirmed an account that could not be told apart).
 */
export function sameImportAccount(confirmed: string | undefined, current: string | undefined): boolean {
  if (confirmed === undefined || current === undefined) return false;
  try {
    const [thenAt, thenAccount] = JSON.parse(confirmed) as [string, string | null];
    const [nowAt, nowAccount] = JSON.parse(current) as [string, string | null];
    if (thenAt !== nowAt) return false;
    if (thenAccount === null || nowAccount === null) return thenAccount === nowAccount;
    return compareProviderAccounts(thenAccount, nowAccount) === 'same';
  } catch {
    return false;
  }
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

/**
 * Whether committed writes sit outside the main file: a `-wal` that holds
 * frames, or a `-journal` waiting to be rolled back. Opening such a file
 * read-write and closing it would merge them into the main file.
 */
function hasUnmergedWrites(path: string): boolean {
  try {
    if (statSync(`${path}-wal`).size > 0) return true;
  } catch {
    // No -wal.
  }
  return existsSync(`${path}-journal`);
}

/** Whether an error from SQLite means another connection has the database locked, as opposed to the database being unreadable. */
function isBusyError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? '');
  const message = String((error as { message?: unknown })?.message ?? error);
  return /SQLITE_(BUSY|LOCKED)/.test(code) || /locked|busy/i.test(message);
}

/** A wait for another connection, in whole milliseconds, never negative. */
const busyWait = (ms: number): number => Math.max(0, Math.floor(ms));

/**
 * Opens a store file to look at it, and proves its schema reads. It is opened
 * read-only first. A read-only connection cannot open a WAL database that has
 * no `-wal` beside it (macOS's SQLite refuses), which is how a store looks
 * after a clean close and would read as damaged, so then, and only when no
 * write waits outside the main file (closing a writable connection merges
 * it), the file is opened writable but query-only. A file another connection
 * has locked is an answer and not a reason to try another way, which would
 * wait again: it throws at once, after at most `busyTimeoutMs`. Throws when
 * neither way reads it. Nothing is written to the database.
 */
function openToLookAt(path: string, busyTimeoutMs: number): Database {
  let failure: unknown;
  for (const mode of [{ readonly: true, create: false }, { readwrite: true, create: false }] as const) {
    if ('readwrite' in mode && hasUnmergedWrites(path)) break;
    let db: Database | undefined;
    try {
      db = new Database(path, mode);
      db.exec(`PRAGMA busy_timeout = ${busyWait(busyTimeoutMs)}; PRAGMA query_only = ON;`);
      db.query('SELECT count(*) AS n FROM sqlite_master').get();
      return db;
    } catch (error) {
      failure = error;
      if (db) closeSqliteStore(db, { checkpoint: false });
      if (isBusyError(error)) break;
    }
  }
  throw failure ?? new Error('The store has writes outside its file.');
}

/** What looking at a store file came to: `busy` when another connection kept it from being read within the wait. */
export type StoreFileLook = 'reads' | 'damaged' | 'busy';

/** Whether a store file opens and its schema reads. Writes nothing to it (SQLite's own `-wal` and `-shm` aside). */
export function storeFileReads(path: string, busyTimeoutMs = 2_000): StoreFileLook {
  let db: Database | undefined;
  try {
    db = openToLookAt(path, busyTimeoutMs);
    return 'reads';
  } catch (error) {
    return isBusyError(error) ? 'busy' : 'damaged';
  } finally {
    if (db) closeSqliteStore(db, { checkpoint: false });
  }
}

/**
 * `PRAGMA quick_check` on a store file, query-only: `ok`, or `damaged` for anything else, a file that will not open
 * included; `busy` when another connection kept it from being read within the wait. It is synchronous and cannot be
 * interrupted, so the caller bounds it by size beforehand.
 */
export function storeFileQuickCheck(path: string, busyTimeoutMs = 2_000): 'ok' | 'damaged' | 'busy' {
  let db: Database | undefined;
  try {
    db = openToLookAt(path, busyTimeoutMs);
    const rows = db.query('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    return rows.length === 1 && Object.values(rows[0]!)[0] === 'ok' ? 'ok' : 'damaged';
  } catch (error) {
    return isBusyError(error) ? 'busy' : 'damaged';
  } finally {
    if (db) closeSqliteStore(db, { checkpoint: false });
  }
}

/** What folding one database's write-ahead log into it came to. */
export type StoreFileCheckpoint = 'folded' | 'busy' | 'not_a_database' | 'failed';

/**
 * `PRAGMA wal_checkpoint(TRUNCATE)` on a store file: every frame of its
 * write-ahead log is written into the database file and the log is emptied, so
 * the file alone is the whole database. The boot migration does it before it
 * plans a move and writes nothing else to the file. `folded` only when the
 * checkpoint ran to the end (not busy, and every frame in the log was
 * checkpointed); a file that is not in write-ahead mode has no log, which is
 * folded. `busy`: another connection kept it from finishing. `not_a_database`:
 * the file is not one SQLite can read. `failed`: anything else.
 */
export function storeFileCheckpoint(path: string, busyTimeoutMs = 2_000): StoreFileCheckpoint {
  let db: Database | undefined;
  try {
    db = new Database(path, { readwrite: true, create: false });
    db.exec(`PRAGMA busy_timeout = ${busyWait(busyTimeoutMs)};`);
    const row = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as Record<string, unknown> | null;
    const [busy, log, checkpointed] = row ? Object.values(row) : [];
    // Not in write-ahead mode: the pragma answers 0, -1, -1.
    return busy === 0 && log === checkpointed ? 'folded' : 'busy';
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    if (isBusyError(error)) return 'busy';
    if (/not a database|malformed|corrupt/i.test(message)) return 'not_a_database';
    return 'failed';
  } finally {
    if (db) closeSqliteStore(db, { checkpoint: false });
  }
}

export const __sourceStorageTestHooks = {
  disableAdoption(): void {
    adoptionEnabled = false;
  },
};
