import {
  SECRET_LOCATIONS_SQLITE_STORE_ID,
  TIER_LEDGER_SQLITE_STORE_ID,
  TIER_SNIFFER_SQLITE_STORE_ID,
  secretLocationsPathForStore,
  tierLedgerPathForStore,
  tierSnifferPathForStore,
} from './workers/classification/tier-ledger-path.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  ACCOUNT_FOLDERS_DIR,
  ACCOUNT_TRASH_DIR,
  accountFoldersRoot,
  accountTrashRoot,
  olympusDataPath,
  olympusDataRoot,
  type LayoutEnv,
} from './core/olympus-layout.ts';
import { declaredConnectorStoreMounts } from './core/source-placement.ts';
import { dataOwnerLockPath, isDataOwnerLockName } from './core/data-owner-lock.ts';
import { Database } from 'bun:sqlite';
import { DEFAULT_STORAGE_SLOT, storeFileOwnerLookup, type StoreFileOwner } from './core/source-storage.ts';
import {
  accountFiles,
  accountFilesPresent,
  lifecycleAccount,
  lifecycleSourceAliases,
  lifecycleSourceFor,
  lifecycleSourceIds,
  lifecycleUnrosteredCorpora,
  retainedCaptureGrants,
  type AccountFiles,
} from './core/account-files.ts';
import { sourceDeleteHolds, type SourceDeleteHold } from './core/source-delete-holds.ts';
import { isUnsupportedDirectorySyncError, writePrivateFileAtomicSync } from './core/atomic-file.ts';
import { OperationError } from './core/operation-error.ts';
import { readSqliteSchemaVersion } from './core/sqlite-migrations.ts';
import {
  REMOTE_CONNECTIONS_STORE_ID,
  remoteConnectionsPreV2BackupPath,
  resolveRemoteConnectionsDbPath,
} from './core/remote-connections.ts';
import {
  WAITING_PRIVATE_QUESTIONS_STORE_ID,
  waitingPrivateQuestionsDbPath,
} from './core/waiting-private-questions.ts';
import { runForgetSteps, type ForgetAccount } from './core/source-forget-registry.ts';
import {
  DEFAULT_ACCOUNT_SLOT,
  dropDeletedAccountsAt,
  dropMovePlans,
  forgetProviderAccountsAt,
  markSourceAccountDeleting,
  readSourceRegistry,
  sourceAccountMovePending,
  sourceRegistryPath,
  SourceRegistryError,
  updateSourceRegistry,
  type SourceRegistry,
  type SourceRegistryAccount,
} from './core/source-registry.ts';
import { defaultSovereigntyConfigPath } from './core/sovereignty.ts';
import {
  olympusDataRoots,
  pairingOwnedRoots,
  pairingSessionPathsFromStoredValue,
} from './core/pairing-session-paths.ts';
import { artifactPresence, type UnpairedSourcesRead } from './workers/credential-broker/unpaired-sources.ts';
import { createSourceCorpusRegistry, withSourceCorpora, type SourceCorpusConfig } from './core/source-corpus-registry.ts';
import { V0_4_PUBLIC_SOURCE_CAPABILITIES } from './core/public-source-capabilities.ts';
import { workerServicePaths, type WorkerServiceState } from './core/worker-service.ts';
import { closeSqliteStore } from './core/sqlite-store.ts';
import { isMediaCachePath, mediaCacheDir, mediaHolderName, releaseMediaCacheFile } from './core/media-cache.ts';
import { storeHolderAtPath, type StoreHolder } from './core/store-identity.ts';
import type { ConnectedHandleRegistry } from './workers/credential-broker/connected-handles.ts';

export interface LifecyclePathContext {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  /**
   * The connected-handle registry the caller works from. The forget registry
   * reads the config files beside it (this-computer.json and the others), so a
   * caller that was given its registry path passes it rather than have it
   * derived from the environment again.
   */
  handleRegistryPath?: string;
}

/**
 * One account the lifecycle exports or deletes: the registry's entry for it
 * (else the account a new one would be, for a source whose files exist with no
 * entry yet), and what it owns on disk (core/account-files.ts). Nothing here
 * names a source: every source-specific fact comes from the registry, the
 * layout module's resolvers and the hold list.
 */
export interface LifecycleAccount {
  sourceId: string;
  /** Older ids the source answered to, which still name its rows in shared files. */
  aliases: readonly string[];
  slot: string;
  /** The registry's entry, when the account has one. */
  entry?: SourceRegistryAccount;
  files: AccountFiles;
  /** What, other than a credential or a pairing, must end before the account may be deleted. */
  holds: readonly SourceDeleteHold[];
}

// The schema marker LocalConnectorStore writes (SQLITE_STORE_ID in
// src/workers/connector-store/local-index.ts). It is what the external-path
// fence verifies before deleting a store outside a known Olympus root, so a
// drift here fails closed: the delete refuses rather than removing a stranger.
const CONNECTOR_STORE_SQLITE_STORE_ID = 'connector-store';
/** Inside an account's folder, never exported: raw ingest state and session secrets. */
const ACCOUNT_FOLDER_UNEXPORTED = ['raw', 'session'] as const;

export interface DataExportResult {
  ok: true;
  destination: string;
  sourceIds: string[];
  files: string[];
  skipped: string[];
  artifacts: DataExportArtifact[];
}

export interface DataExportArtifact {
  sourceId: string;
  role: 'legacy_store' | 'connector_store' | 'sanitized_config';
  relativePath: string;
  bytes: number;
  sha256: string;
  sqlite?: {
    integrityCheck: 'ok';
    foreignKeyViolations: number;
    expectedStoreId: string;
    schemaVersion: number;
  };
}

export interface DataExportVerificationResult {
  ok: true;
  destination: string;
  artifactCount: number;
  artifacts: Array<{ relativePath: string; bytes: number; sha256: string }>;
}

export interface DataDeleteResult {
  ok: true;
  mode: 'all' | 'source';
  sourceId?: string;
  dryRun: boolean;
  removed: string[];
  missing: string[];
  /** Shared files the source's rows were forgotten from (on a dry run, would be), by the forget registry. */
  forgotten?: string[];
  /**
   * The account is marked `deleting` and its files (`removed`) go when the
   * worker next starts, before anything opens them (`applyAtRestart`).
   */
  pending?: true;
}

export interface DataDeleteCustody {
  requirement: 'source_disconnected' | 'worker_inactive';
  ready: boolean;
  observed: 'disconnected' | 'connected' | 'paired' | 'unpair_incomplete' | 'unpair_state_unreadable' | WorkerServiceState | 'unknown_registry' | 'relay_running' | 'engine_loaded';
  next_action?: string;
}

export interface DataDeleteWithCustodyResult extends DataDeleteResult {
  custody: DataDeleteCustody;
}

interface DeleteTarget {
  path: string;
  kind: 'known_root' | 'service_unit' | 'source_sqlite' | 'source_sqlite_sidecar' | 'source_state_path' | 'policy_file' | 'account_folder' | 'registry_file';
  allowRecursive: boolean;
  /** An `account_folder`'s data root: the folder must lie under it, through no link. */
  ownedRoot?: string;
  sqliteStoreId?: string;
  sqlitePrimaryPath?: string;
  externalSourcePath?: boolean;
}

const DELETE_CONFIRMATION_1 = 'DELETE OLYMPUS DATA';
const DELETE_CONFIRMATION_2 = 'DELETE EVERYTHING';

/** The source each store file in the lifecycle's inventory belongs to, by the file itself. */
export function lifecycleStoreFileOwner(env: Record<string, string | undefined>): StoreFileOwner {
  return storeFileOwnerLookup(knownAccounts({ env }).flatMap((account) =>
    account.files.stores.map((path) => [path, account.sourceId] as const)));
}

/** What one source's account owns on disk, as Export and Delete see it now. */
export function lifecycleAccountFiles(sourceId: string, context: LifecyclePathContext = {}): AccountFiles {
  return requireAccount(sourceId, context).files;
}

/** Every store of every account the lifecycle knows: the tier CLI's lookup. */
export function lifecycleStorePaths(context: LifecyclePathContext = {}): string[] {
  return knownAccounts(context).flatMap((account) => account.files.stores);
}

/**
 * The account of a source the lifecycle knows (by id or alias): the
 * registry's entry for its slot, else the account a new one would be placed
 * as. A registry that cannot be read leaves the layout to what is on disk
 * (core/source-placement.ts), so a delete or an export still finds the files.
 */
function lifecycleAccountOf(sourceId: string, context: LifecyclePathContext, registry?: SourceRegistry | 'unreadable'): LifecycleAccount {
  const env = envForContext(context);
  const read = registry ?? readRegistryOrUnreadable(env);
  const entry = read === 'unreadable'
    ? undefined
    : read.accounts.find((account) => account.source_id === sourceId && account.slot === DEFAULT_ACCOUNT_SLOT);
  const placed = entry
    ? { source_id: sourceId, slot: entry.slot, layout: entry.layout }
    : lifecycleAccount(sourceId, env);
  return {
    sourceId,
    aliases: lifecycleSourceAliases(sourceId),
    slot: placed.slot,
    ...(entry ? { entry } : {}),
    files: accountFiles(placed, { env, ...(context.homeDir ? { homeDir: context.homeDir } : {}) }),
    holds: sourceDeleteHolds(sourceId),
  };
}

/** One account per source the lifecycle knows, whether or not it holds anything. */
function knownAccounts(context: LifecyclePathContext): LifecycleAccount[] {
  const registry = readRegistryOrUnreadable(envForContext(context));
  return lifecycleSourceIds().map((sourceId) => lifecycleAccountOf(sourceId, context, registry));
}

/**
 * The accounts that exist: every registry entry, and every source with files
 * on disk but no entry yet (an install whose worker never adopted it). An
 * account being deleted is left out: its data is already on its way out.
 */
function existingAccounts(context: LifecyclePathContext): LifecycleAccount[] {
  return knownAccounts(context).filter((account) =>
    account.entry ? account.entry.state === 'active' : accountFilesPresent(account.files));
}

/**
 * The registry, or `unreadable` when it cannot be read or the data folder
 * cannot be worked out: then no entry is known, and placement decides each
 * account's layout from what is on disk, as it does for every resolver.
 */
function readRegistryOrUnreadable(env: LayoutEnv): SourceRegistry | 'unreadable' {
  try {
    return readSourceRegistry(env);
  } catch {
    return 'unreadable';
  }
}

export function exportOlympusData(options: {
  destination: string;
  sourceId?: string;
} & LifecyclePathContext): DataExportResult {
  const destination = requirePath(options.destination, '--output');
  const selected = selectExportAccounts(options.sourceId, options);
  refuseExportDuringMove(selected, options);
  // Computed BEFORE anything is created: once mkdir -p has run, the directories
  // it made are indistinguishable from the ones that were already there.
  const durabilityBoundary = exportDurabilityBoundary(destination);
  makeDurableDirectory(destination, durabilityBoundary);
  // The manifest is the commit record for THIS run, and a retry into a reused
  // destination immediately starts overwriting the snapshots the previous run's
  // manifest describes. Revoking it first costs one unlink; leaving it standing
  // lets a run that dies partway through present a mixture of two exports as a
  // completed one.
  rmSync(join(destination, 'manifest.json'), { force: true });
  syncDirectorySync(destination);
  const files: string[] = [];
  const skipped: string[] = [];
  const artifacts: DataExportArtifact[] = [];

  for (const source of selected) {
    const sourceRoot = join(destination, 'sources', safePathSegment(source.sourceId));
    makeDurableDirectory(sourceRoot, durabilityBoundary);
    const legacyIndex = source.files.preCutoverIndex;
    if (legacyIndex) {
      exportSqliteStore({
        sqlitePath: legacyIndex.path,
        destinationRoot: sourceRoot,
        exportRoot: destination,
        sourceId: source.sourceId,
        role: 'legacy_store',
        expectedStoreId: legacyIndex.storeId,
        files,
        skipped,
        artifacts,
      });
    }
    for (const storePath of source.files.stores) {
      exportSqliteStore({
        sqlitePath: storePath,
        destinationRoot: sourceRoot,
        exportRoot: destination,
        sourceId: source.sourceId,
        role: 'connector_store',
        expectedStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
        files,
        skipped,
        artifacts,
      });
    }
    for (const policyPath of source.files.settings) {
      const destinationPath = join(sourceRoot, basename(policyPath));
      if (copySanitizedJsonIfPresent(policyPath, destinationPath, files, skipped)) {
        artifacts.push(fileArtifact(destination, destinationPath, source.sourceId, 'sanitized_config'));
      }
    }
    // Raw ingest and session state are never copied — the spool is unnormalized
    // input the store already holds, and the session is the secret material
    // this export exists to leave behind. They are still named, because a
    // manifest that omits them entirely is how the owner learns too late that
    // `delete --all` took something the export never had.
    for (const statePath of source.files.raw) skipped.push(statePath);
    for (const state of source.files.rawDatabases) skipped.push(state.path);
    for (const statePath of source.files.preserved) skipped.push(statePath);
    // An account folder's own raw and session folders, whatever the source
    // names inside them, are never copied either.
    const folder = source.files.folder;
    if (folder) {
      for (const name of ACCOUNT_FOLDER_UNEXPORTED) {
        const path = join(folder, name);
        if (existsSync(path) && !skipped.includes(path)) skipped.push(path);
      }
    }
  }

  // Remote-agent connections are credentials (token digests), which an export
  // leaves behind like every other secret. Named, so the manifest says so.
  // Waiting private questions are Private-derived questions kept only until
  // answered on this computer: never exported, named like the connections.
  if (options.sourceId === undefined) {
    const connectionsPath = resolveRemoteConnectionsDbPath(envForContext(options));
    for (const path of [connectionsPath, remoteConnectionsPreV2BackupPath(connectionsPath), waitingPrivateQuestionsDbPath(connectionsPath)]) {
      if (existsSync(path)) skipped.push(path);
    }
  }

  const configRoot = join(destination, 'config');
  makeDurableDirectory(configRoot, durabilityBoundary);
  for (const [sourcePath, destinationPath] of [
    [join(resolveHome(options.homeDir), '.olympus', 'config.json'), join(configRoot, 'config.json')],
    [defaultSovereigntyConfigPathForHome(options.homeDir), join(configRoot, 'sovereignty.json')],
  ] as const) {
    if (copySanitizedJsonIfPresent(sourcePath, destinationPath, files, skipped)) {
      artifacts.push(fileArtifact(destination, destinationPath, 'olympus.config', 'sanitized_config'));
    }
  }
  // The manifest is the export's commit record, so it is published LAST and
  // atomically. A manifest that reaches the disk before the data it describes
  // is what turns "export, then delete" into silent loss: the owner reads a
  // success they do not have.
  writePrivateFileAtomicSync(join(destination, 'manifest.json'), JSON.stringify({
    kind: 'olympus_data_export',
    version: 2,
    exported_at: new Date().toISOString(),
    source_ids: selected.map((source) => source.sourceId),
    // Where each account's files were (additive: a verifier of this version ignores it).
    accounts: selected.map((source) => ({ source_id: source.sourceId, slot: source.slot, layout: source.files.account.layout })),
    secrets_excluded: true,
    files,
    skipped,
    artifacts,
  }, null, 2));
  files.push(join(destination, 'manifest.json'));

  return { ok: true, destination, sourceIds: selected.map((source) => source.sourceId), files, skipped, artifacts };
}

export function verifyOlympusDataExport(options: { destination: string }): DataExportVerificationResult {
  const destination = resolve(requirePath(options.destination, '--input'));
  const manifestPath = join(destination, 'manifest.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    kind?: unknown;
    version?: unknown;
    artifacts?: unknown;
  };
  if (parsed.kind !== 'olympus_data_export' || parsed.version !== 2 || !Array.isArray(parsed.artifacts)) {
    throw new OperationError('source_index_error', 'Olympus data export manifest is unsupported or incomplete.');
  }
  const verified: Array<{ relativePath: string; bytes: number; sha256: string }> = [];
  for (const value of parsed.artifacts) {
    const artifact = parseExportArtifact(value);
    const path = resolve(destination, artifact.relativePath);
    if (!isSameOrInsidePath(path, destination) || path === destination) {
      throw new OperationError('source_index_error', 'Olympus data export manifest contains an unsafe artifact path.');
    }
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size !== artifact.bytes || sha256File(path) !== artifact.sha256) {
      throw new OperationError(
        'source_index_error',
        `Olympus data export artifact failed verification: ${artifact.relativePath}`,
      );
    }
    if (artifact.sqlite) assertSqliteSnapshotIntact(path, artifact.relativePath);
    verified.push({ relativePath: artifact.relativePath, bytes: artifact.bytes, sha256: artifact.sha256 });
  }
  return { ok: true, destination, artifactCount: verified.length, artifacts: verified };
}

export function deleteOlympusData(options: {
  all?: boolean;
  sourceId?: string;
  dryRun?: boolean;
  /**
   * Mark the account `deleting` and leave its files for the worker's next boot
   * (deleteMarkedAccounts), instead of removing them now: what the running
   * worker does, which holds the account's stores open until it restarts.
   */
  applyAtRestart?: boolean;
} & LifecyclePathContext): DataDeleteResult {
  if (options.all === true && options.sourceId) {
    throw new OperationError('invalid_params', 'Use either --all or --source, not both.');
  }
  if (options.all !== true && !options.sourceId) {
    throw new OperationError('invalid_params', 'Data delete requires --all or --source <id>.');
  }
  if (options.all === true) return deleteAllOlympusData(options);

  const account = requireAccount(options.sourceId, options);
  const env = envForContext(options);
  // Every check runs before anything is forgotten, marked or removed: a refusal changes nothing.
  const plan = planAccountRemoval(account, options);
  if (options.dryRun === true) {
    const media = readSourceMedia(account.sourceId, account.files.stores, env);
    return {
      ok: true,
      mode: 'source',
      sourceId: account.sourceId,
      dryRun: true,
      removed: [...plan.present, ...releaseSourceMedia(media, true)],
      missing: plan.missing,
      ...optionalList('forgotten', forgetSharedRows(account, { ...options, dryRun: true })),
    };
  }
  // Forget the account's rows in the shared files (the forget registry),
  // starting with the dependent private answers, before it is marked and any
  // of its bytes go. A failing step fails the delete here, with every store in
  // place and the account still open.
  const forgotten = forgetSharedRows(account, options);
  if (options.applyAtRestart === true) {
    // From here the storage service opens none of its files, and the worker's
    // next boot removes them before anything mounts. Marked even with nothing
    // on disk: the boot's repeat of the forget steps still runs for it.
    markAccountDeleting(account, env);
    return {
      ok: true,
      mode: 'source',
      sourceId: account.sourceId,
      dryRun: false,
      pending: true,
      removed: plan.present,
      missing: plan.missing,
      ...optionalList('forgotten', forgotten),
    };
  }
  // The caller owns the data (the CLI under the owner lock, nothing open): the
  // marker goes first, so a delete that stops part way is finished by the
  // worker's next boot, and the files go now.
  // An account with no entry and nothing on disk (never connected) has nothing to mark.
  const exists = account.entry !== undefined || plan.present.length > 0;
  const marked = exists && markAccountDeletingIfReadable(account, env);
  const { removed, missing } = removeAccount(account, plan, options, { background: false });
  finishAccountDelete(account, env, plan.registryPath, marked);
  return {
    ok: true,
    mode: 'source',
    sourceId: account.sourceId,
    dryRun: false,
    removed,
    missing,
    ...optionalList('forgotten', forgotten),
  };
}

/** What a boot's pass over the accounts marked `deleting` did. */
export interface DeleteMarkedAccountsReport {
  deleted: Array<{ sourceId: string; removed: number }>;
  failed: Array<{ sourceId: string; message: string }>;
}

/**
 * Worker boot, holding the owner lock and before anything mounts or capture
 * starts (docs/design/source-storage.md, "Delete"): removes each account the
 * registry marks `deleting`. Its folder is renamed into `<data>/.trash/` in one
 * step and emptied in the background; a legacy account's files are removed
 * where they are; its picture holds are released; the forget steps that the
 * worker's own background writers could have undone since the account was
 * marked run again (the others ran when it was marked, and a repeat could
 * erase a reconnect made since); and the entry is dropped. A failure leaves the
 * entry `deleting`, so the account stays closed and the next boot retries; the
 * other accounts are unaffected. An unreadable registry throws: nothing can be
 * told about any account.
 */
export function deleteMarkedAccounts(context: LifecyclePathContext = {}): DeleteMarkedAccountsReport {
  const env = envForContext(context);
  const registry = readSourceRegistry(env);
  const report: DeleteMarkedAccountsReport = { deleted: [], failed: [] };
  const marked = registry.accounts.filter((entry) => entry.state === 'deleting');
  for (const entry of marked) {
    try {
      const sourceId = lifecycleSourceFor(entry.source_id);
      if (!sourceId || entry.slot !== DEFAULT_ACCOUNT_SLOT) {
        throw new Error('Olympus does not know where this account\'s files are');
      }
      const account = lifecycleAccountOf(sourceId, context, registry);
      const plan = planAccountRemoval(account, context);
      forgetSharedRows(account, context, { repeatableOnly: true });
      const { removed } = removeAccount(account, plan, context, { background: true });
      finishAccountDelete(account, env, plan.registryPath, true);
      report.deleted.push({ sourceId, removed: removed.length });
    } catch (error) {
      report.failed.push({ sourceId: entry.source_id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  emptyAccountTrash(env, { background: true });
  return report;
}

/**
 * Delete all: every account's files, the shared files, the media cache, the
 * registry and the known legacy leftovers, under the owner lock with the
 * engine stopped. The owner lock itself stays.
 */
function deleteAllOlympusData(options: { dryRun?: boolean } & LifecyclePathContext): DataDeleteResult {
  const targets = uniqueTargets(allDeleteTargets(options));
  // Resolved once with the targets: removing the config folder can change
  // what the data root resolves to (on standalone Linux its receipt lives
  // there), and the lock held and the registry read are the ones found now.
  const ownerLockPath = dataOwnerLockPath(envForContext(options));
  const registryPath = sourceRegistryPath(envForContext(options));
  assertRawStateTargetsContained(targets, options, undefined);
  assertSourcesFolderTargetsUnlinked(targets, options);
  for (const target of targets) {
    if (existsSync(target.path)) assertDeleteTargetSafe(target);
  }
  const removed: string[] = [];
  const missing: string[] = [];
  for (const target of targets) {
    if (!existsSync(target.path)) {
      missing.push(target.path);
      continue;
    }
    removed.push(target.path);
    if (options.dryRun !== true) rmTargetKeepingOwnerLock(target, ownerLockPath);
  }
  // A registry the targets did not reach (a data folder outside every known
  // root keeps it there) names no account's history any more.
  if (options.dryRun !== true) {
    try {
      forgetProviderAccountsAt(registryPath);
    } catch (error) {
      if (!(error instanceof SourceRegistryError)) throw error;
    }
  }
  return { ok: true, mode: 'all', dryRun: options.dryRun === true, removed, missing };
}

/** What a per-source delete removes, checked: every refusal happens here, before anything changes. */
interface AccountRemovalPlan {
  targets: DeleteTarget[];
  present: string[];
  missing: string[];
  /** The registry the account's entry is in, found before anything is removed. */
  registryPath: string;
}

function planAccountRemoval(account: LifecycleAccount, context: LifecyclePathContext): AccountRemovalPlan {
  const targets = uniqueTargets(sourceDeleteTargets(account, context));
  // A recursive raw-state target must be provably Olympus's own and nobody
  // else's (see assertRawStateTargetsContained), and everything under the
  // account folders is reached through no link, so a store inside one
  // account's folder is never another account's.
  assertRawStateTargetsContained(targets, context, account);
  assertSourcesFolderTargetsUnlinked(targets, context);
  for (const target of targets) {
    if (existsSync(target.path)) assertDeleteTargetSafe(target);
  }
  return {
    targets,
    present: targets.filter((target) => existsSync(target.path)).map((target) => target.path),
    missing: targets.filter((target) => !existsSync(target.path)).map((target) => target.path),
    registryPath: sourceRegistryPath(envForContext(context)),
  };
}

/**
 * Removes the account's files: its folder by one rename into the trash (then
 * emptied, in the background at boot), every other target where it is. Its
 * photo copies live in the shared media cache: every store's references are
 * read first, and each copy is released only once its stores are gone, and
 * removed unless another account's store still holds it. A store that cannot
 * be read stops the delete with every file in place.
 */
function removeAccount(
  account: LifecycleAccount,
  plan: AccountRemovalPlan,
  context: LifecyclePathContext,
  options: { background: boolean },
): { removed: string[]; missing: string[] } {
  const env = envForContext(context);
  const ownerLockPath = dataOwnerLockPath(env);
  const media = readSourceMedia(account.sourceId, account.files.stores, env);
  // The media reads and the shared-file work before them can wait on SQLite
  // locks, so the link checks run again right before the first removal: a
  // folder swapped for a link meanwhile is refused, not followed.
  assertSourcesFolderTargetsUnlinked(plan.targets, context);
  for (const target of plan.targets) {
    if (target.kind === 'account_folder' && existsSync(target.path)) assertDeleteTargetSafe(target);
  }
  const removed: string[] = [];
  const missing: string[] = [];
  // A file inside the folder goes with the folder's rename, not on its own.
  const folders = plan.targets.filter((target) => target.kind === 'account_folder').map((target) => resolve(target.path));
  for (const target of plan.targets) {
    if (!existsSync(target.path)) {
      missing.push(target.path);
      continue;
    }
    removed.push(target.path);
    if (target.kind === 'account_folder') moveAccountFolderToTrash(target.path, env, options);
    else if (!folders.some((folder) => isStrictlyInside(resolve(target.path), folder))) rmTargetKeepingOwnerLock(target, ownerLockPath);
  }
  removed.push(...releaseSourceMedia(media, false));
  return { removed, missing };
}

/**
 * The account's files are gone: its entry goes too (with any move plan and the
 * provider account it named), so a reconnect starts a new account, placed
 * afresh. An entry that was never written (an unreadable registry) has nothing
 * to drop; one left by a delete that stopped before this is dropped by the
 * next. A registry that cannot be read must not undo a delete that has taken
 * the files.
 */
function finishAccountDelete(account: LifecycleAccount, env: LayoutEnv, registryPath: string, marked: boolean): void {
  const own = [account.sourceId, ...account.aliases];
  try {
    if (marked) dropDeletedAccountsAt(registryPath, own, account.slot);
    // A move that was part way had put files in both places, and both are
    // gone; and the provider account the history belonged to is forgotten,
    // for an entry that stayed (unmarked).
    dropMovePlans(env, own);
    forgetProviderAccountsAt(registryPath, own);
  } catch (error) {
    if (!(error instanceof SourceRegistryError)) throw error;
  }
}

function markAccountDeleting(account: LifecycleAccount, env: LayoutEnv): void {
  try {
    markSourceAccountDeleting(env, {
      sourceIds: [account.sourceId, ...account.aliases],
      sourceId: account.sourceId,
      slot: account.slot,
      layout: account.files.account.layout,
    });
  } catch (error) {
    if (!(error instanceof SourceRegistryError)) throw error;
    throw new OperationError(
      'source_index_error',
      `${error.message} The account cannot be marked for deletion, so nothing was deleted.`,
      'Repair or restore that file, then delete again.',
    );
  }
}

/** The marker, when the registry can be read; a CLI delete with nothing open removes the files either way. */
function markAccountDeletingIfReadable(account: LifecycleAccount, env: LayoutEnv): boolean {
  try {
    markAccountDeleting(account, env);
    return true;
  } catch (error) {
    if (error instanceof OperationError && error.code === 'source_index_error') return false;
    throw error;
  }
}

/**
 * Renames an account's folder into `<data>/.trash/<uuid>` (one rename on the
 * same volume: the folder either is where it was or is gone from there), then
 * empties the trash. A trash that is not a plain folder of the data root, or a
 * rename the file system refuses (the sources folder on another volume), falls
 * back to removing the folder where it is.
 */
function moveAccountFolderToTrash(folder: string, env: LayoutEnv, options: { background: boolean }): void {
  const trash = accountTrashRoot(env);
  let moved = false;
  try {
    mkdirSync(trash, { recursive: true, mode: 0o700 });
    const dataRoot = olympusDataRoot(env);
    if (lstatSync(trash).isDirectory() && canonicalPath(trash) === join(canonicalPath(dataRoot), relative(resolve(dataRoot), resolve(trash)))) {
      renameSync(folder, join(trash, randomUUID()));
      moved = true;
    }
  } catch {
    moved = false;
  }
  if (!moved) {
    rmSync(folder, { recursive: true, force: true });
    return;
  }
  emptyAccountTrash(env, options);
}

/** Empties `<data>/.trash`: what a delete renamed there, and leftovers of one a crash stopped. */
function emptyAccountTrash(env: LayoutEnv, options: { background: boolean }): void {
  let trash: string;
  let names: string[];
  try {
    trash = accountTrashRoot(env);
    if (!lstatSync(trash).isDirectory()) return;
    names = readdirSync(trash);
  } catch {
    return;
  }
  // The trash itself goes once it is empty; one still holding something stays for the next pass.
  const removeEmptyTrash = (): void => {
    try {
      rmdirSync(trash);
    } catch {
      // Not empty, or already gone.
    }
  };
  if (options.background) {
    void Promise.allSettled(names.map((name) => rm(join(trash, name), { recursive: true, force: true }))).then(removeEmptyTrash);
    return;
  }
  for (const name of names) rmSync(join(trash, name), { recursive: true, force: true });
  removeEmptyTrash();
}

function optionalList<K extends string>(key: K, values: string[]): Partial<Record<K, string[]>> {
  return values.length > 0 ? { [key]: values } as Record<K, string[]> : {};
}

/**
 * The forget registry's steps for one account (core/source-forget-registry.ts),
 * or on a dry run what they would forget; with `repeatableOnly`, just the
 * steps whose rows the worker's own background writers can write back (the
 * boot pass's repeat). The account's corpora are the registry entry's joined
 * with the shipped corpus registry's for the source (its id and aliases), the
 * way the private answers were placed before.
 */
function forgetSharedRows(
  source: LifecycleAccount,
  options: { dryRun?: boolean } & LifecyclePathContext,
  only: { repeatableOnly?: boolean } = {},
): string[] {
  const env = envForContext(options);
  const own = new Set([source.sourceId, ...source.aliases]);
  const shipped = createSourceCorpusRegistry(withSourceCorpora(undefined, lifecycleUnrosteredCorpora())).list();
  let registered: string[] = [];
  try {
    registered = readSourceRegistry(env).accounts
      .filter((account) => account.slot === DEFAULT_STORAGE_SLOT && own.has(account.source_id))
      .flatMap((account) => account.corpus_ids);
  } catch (error) {
    // A registry that cannot be read must not keep the owner from deleting;
    // the shipped corpora are the ones the delete has always placed answers by.
    if (!(error instanceof SourceRegistryError)) throw error;
  }
  const account: ForgetAccount = {
    source_id: source.sourceId,
    slot: DEFAULT_STORAGE_SLOT,
    corpus_ids: [...new Set([
      ...registered,
      ...shipped.filter((corpus) => own.has(corpus.sourceId)).map((corpus) => corpus.corpusId),
    ])],
  };
  // The ids of the source's tier ledgers, read now while the ledger files
  // still exist: they are the claimants of its Secrets redaction claims.
  const ledgers = only.repeatableOnly === true
    ? { ids: [], unreadable: [] }
    : readTierLedgerIds(source.files.stores);
  return runForgetSteps(account, {
    env,
    handleRegistryPath: handleRegistryPathFor(options),
    sourceAliases: source.aliases,
    knownCorpusIds: shipped.map((corpus) => corpus.corpusId),
    tierLedgerIds: ledgers.ids,
    unreadableTierLedgers: ledgers.unreadable,
  }, { dryRun: options.dryRun === true, ...(only.repeatableOnly === true ? { repeatableOnly: true } : {}) });
}

function handleRegistryPathFor(context: LifecyclePathContext): string {
  return context.handleRegistryPath
    || envForContext(context).OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH?.trim()
    || join(resolveHome(context.homeDir), '.config', 'olympus', 'handles.json');
}

/**
 * The ids of the tier ledgers beside a source's stores (the ledger file's
 * identity, `tier_ledger_meta.ledger_id`). A ledger that is not there, or has
 * no identity yet, never held a claim; one that exists but cannot be read is
 * listed, and its claims are left alone.
 */
function readTierLedgerIds(storePaths: readonly string[]): { ids: string[]; unreadable: string[] } {
  const ids = new Set<string>();
  const unreadable: string[] = [];
  for (const storePath of storePaths) {
    if (storePath === ':memory:') continue;
    const ledgerPath = tierLedgerPathForStore(storePath);
    if (!existsSync(ledgerPath)) continue;
    let db: Database | undefined;
    try {
      db = new Database(ledgerPath, { readonly: true });
      db.exec('PRAGMA busy_timeout = 10000;');
      const meta = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tier_ledger_meta'").get();
      const row = meta
        ? db.query("SELECT value FROM tier_ledger_meta WHERE key = 'ledger_id'").get() as { value?: unknown } | null
        : null;
      if (typeof row?.value === 'string' && row.value !== '') ids.add(row.value);
    } catch {
      unreadable.push(ledgerPath);
    } finally {
      if (db) closeSqliteStore(db);
    }
  }
  return { ids: [...ids], unreadable };
}

/**
 * Public CLI custody wrapper around the mechanical delete primitive.
 *
 * A per-source delete may run while the worker stays up only after the source
 * has been disconnected, which removes it from the active scheduler before
 * any store bytes can be removed. Delete-all instead requires the supervised
 * worker to be inactive or absent. Dry runs never mutate and report an unmet
 * prerequisite so the owner can preview first.
 */
export function deleteOlympusDataWithCustody(options: {
  all?: boolean;
  sourceId?: string;
  dryRun?: boolean;
  /** The running worker: mark the account and remove it at the next boot (see deleteOlympusData). */
  applyAtRestart?: boolean;
  connectedRegistry?: ConnectedHandleRegistry;
  unpairedSources?: UnpairedSourcesRead;
  artifactPresence?: (path: string) => 'gone' | 'present' | 'unknown';
  /** Source ids connected on this computer without a credential (see core/this-computer.ts). */
  thisComputerSources?: readonly string[];
  workerState?: WorkerServiceState;
  /** A remote-access relay child is running (it would recreate its keys and keep forwarding). */
  relayRunning?: boolean;
  /**
   * The standalone engine's LaunchAgent is loaded. Running or not, launchd
   * keeps it alive and would start its worker again mid-delete.
   */
  engineLoaded?: boolean;
} & LifecyclePathContext): DataDeleteWithCustodyResult {
  // A source whose approvals move between stores is checked and deleted
  // under their exclusion; every other source as before.
  const sourceId = options.dryRun !== true && options.sourceId ? lifecycleSourceFor(options.sourceId) : undefined;
  const holds = sourceId ? sourceDeleteHolds(sourceId) : [];
  const env = envForContext(options);
  return holds.reduce<() => DataDeleteWithCustodyResult>(
    (run, hold) => () => hold.exclusive(env, run),
    () => deleteUnderCustody(options),
  )();
}

function deleteUnderCustody(options: Parameters<typeof deleteOlympusDataWithCustody>[0]): DataDeleteWithCustodyResult {
  const custody = dataDeleteCustody(options);
  if (options.dryRun !== true && !custody.ready) {
    throw new OperationError(
      'invalid_params',
      custody.requirement === 'source_disconnected'
        // Unpair or Disconnect by what the SOURCE is (a paired session), never
        // by what custody happened to observe: an unreadable registry on a
        // Dropbox delete is still a Disconnect source.
        ? requireAccount(options.sourceId, options).files.pairing
          ? `Unpair ${options.sourceId} cleanly before deleting its local data (${custody.observed.replace(/_/g, ' ')}).`
          : `Disconnect ${options.sourceId} before deleting its local data.`
        : custody.observed === 'relay_running'
          ? 'Turn remote access off before deleting local data: the relay process is still running.'
          : custody.observed === 'engine_loaded'
            ? 'Stop the Olympus engine before deleting local data: launchd would start it again.'
            : 'Stop or uninstall the Olympus worker before deleting local data.',
      custody.next_action,
    );
  }
  return {
    ...deleteOlympusData(options),
    custody,
  };
}

export function dataDeleteCustody(options: {
  all?: boolean;
  sourceId?: string;
  connectedRegistry?: ConnectedHandleRegistry;
  thisComputerSources?: readonly string[];
  /**
   * The durable unpaired-source record, read the way the dashboard reads it
   * (reconciled against the disk). Required for a paired-session source.
   */
  unpairedSources?: UnpairedSourcesRead;
  /** Tests inject disk presence; real callers leave it. */
  artifactPresence?: (path: string) => 'gone' | 'present' | 'unknown';
  workerState?: WorkerServiceState;
  relayRunning?: boolean;
  engineLoaded?: boolean;
} & LifecyclePathContext): DataDeleteCustody {
  if (options.all === true && options.sourceId) {
    throw new OperationError('invalid_params', 'Use either --all or --source, not both.');
  }
  if (options.all !== true && !options.sourceId) {
    throw new OperationError('invalid_params', 'Data delete requires --all or --source <id>.');
  }

  const source = options.sourceId ? requireAccount(options.sourceId, options) : undefined;
  const publicCapability = source
    ? V0_4_PUBLIC_SOURCE_CAPABILITIES.find((candidate) =>
        candidate.source_id === source.sourceId || source.aliases.includes(candidate.source_id)
      )
    : undefined;
  if (publicCapability) {
    if (!options.connectedRegistry || (options.connectedRegistry.dropped?.length ?? 0) > 0) {
      return {
        requirement: 'source_disconnected',
        ready: false,
        observed: 'unknown_registry',
        next_action: 'Repair the Olympus connected-handle registry, then Disconnect this source and retry.',
      };
    }
    const lane = publicCapability.doctor_lane;
    // A source with no credential has no handle to disconnect; it
    // is connected in the this-computer record instead, which is checked here.
    const connected = (lane !== undefined
      && options.connectedRegistry.handles.some((handle) => handle.provider === lane.provider))
      || (options.thisComputerSources?.includes(source!.sourceId) ?? false);
    const pairingPaths = source!.files.pairing;
    if (connected) {
      // A paired-session source ends with Unpair, not Disconnect.
      return pairingPaths
        ? {
            requirement: 'source_disconnected',
            ready: false,
            observed: 'paired',
            next_action: 'Use Unpair in the local dashboard, then rerun the CLI delete.',
          }
        : {
            requirement: 'source_disconnected',
            ready: false,
            observed: 'connected',
            next_action: 'Use Disconnect in the local dashboard, then rerun the CLI delete.',
          };
    }
    const held = source!.holds.find((hold) => hold.present(envForContext(options)));
    if (held) {
      return {
        requirement: 'source_disconnected',
        ready: false,
        observed: 'connected',
        next_action: held.nextAction,
      };
    }
    // A paired-session source (Telegram, WhatsApp) has no handle to disconnect
    // and its card infers a live session from sync evidence, so "no handle" is
    // not "disconnected". Only a CLEAN Unpair is: the unpaired record says
    // `unpaired` and no pairing artifact is left on disk. Anything else is a
    // pairing that is live, half-removed, or whose state cannot be read.
    if (pairingPaths) {
      const read = options.unpairedSources;
      if (!read || read.status === 'unreadable') {
        return {
          requirement: 'source_disconnected',
          ready: false,
          observed: 'unpair_state_unreadable',
          next_action: 'Repair the Olympus unpaired-source record, then Unpair this source and retry.',
        };
      }
      const record = read.status === 'ok'
        ? read.records.find((candidate) => candidate.source_id === source!.sourceId)
        : undefined;
      if (!record) {
        return {
          requirement: 'source_disconnected',
          ready: false,
          observed: 'paired',
          next_action: 'Use Unpair in the local dashboard, then retry.',
        };
      }
      const presence = options.artifactPresence ?? artifactPresence;
      if (record.state !== 'unpaired' || pairingPaths.some((path) => presence(path) !== 'gone')) {
        return {
          requirement: 'source_disconnected',
          ready: false,
          observed: record.state === 'unpaired' ? 'paired' : 'unpair_incomplete',
          next_action: 'Finish Unpair in the local dashboard (remove what it lists), then retry.',
        };
      }
    }
    return {
      requirement: 'source_disconnected',
      ready: true,
      observed: 'disconnected',
    };
  }

  if (options.engineLoaded === true) {
    return {
      requirement: 'worker_inactive',
      ready: false,
      observed: 'engine_loaded',
      next_action: 'Run olympus engine stop (it stays stopped until olympus engine start), check olympus engine status, then retry.',
    };
  }
  const workerState = options.workerState;
  const ready = workerState === 'inactive' || workerState === 'missing';
  // Like the worker, the remote-access relay child must be down: it holds its
  // keys and state under the data root and would keep forwarding to (and
  // re-creating) what the delete removes.
  if (ready && options.all === true && options.relayRunning === true) {
    return {
      requirement: 'worker_inactive',
      ready: false,
      observed: 'relay_running',
      next_action: 'Run openclaw config set plugins.entries.olympus.config.remote.enabled false (or stop the OpenClaw Gateway), check olympus connections status, then retry.',
    };
  }
  return {
    requirement: 'worker_inactive',
    ready,
    observed: workerState ?? 'unknown',
    ...(!ready
      ? { next_action: 'Run olympus worker stop (or olympus worker uninstall), verify status, then retry.' }
      : {}),
  };
}

export function validateDeleteAllConfirmations(first: string, second: string): void {
  if (first !== DELETE_CONFIRMATION_1 || second !== DELETE_CONFIRMATION_2) {
    throw new OperationError(
      'invalid_params',
      'delete --all requires both confirmation phrases.',
      `Type "${DELETE_CONFIRMATION_1}" and then "${DELETE_CONFIRMATION_2}", or use --yes-i-am-sure in automated tests.`,
    );
  }
}

export function deleteAllConfirmationPrompts(): { first: string; second: string } {
  return { first: DELETE_CONFIRMATION_1, second: DELETE_CONFIRMATION_2 };
}

/** The data root this context's paths resolve under (core/olympus-layout.ts). */
export function lifecycleDataRoot(context: LifecyclePathContext = {}): string {
  return olympusDataRoot(envForContext(context));
}

export function knownOlympusDataRoots(context: LifecyclePathContext = {}): string[] {
  return olympusDataRoots({ homeDir: resolveHome(context.homeDir) });
}

function allDeleteTargets(context: LifecyclePathContext): DeleteTarget[] {
  const home = resolveHome(context.homeDir);
  return [
    ...knownAccounts(context).flatMap((account) => sourceDeleteTargets(account, context)),
    // The registry: every account it lists is being deleted.
    ...registryDeleteTargets(context),
    // Approved remote-agent connections. Removing the database revokes every
    // connection token at once. Named on its own because an explicit
    // OLYMPUS_REMOTE_CONNECTIONS_DB_PATH or XDG_DATA_HOME can put it outside
    // the known roots below.
    ...remoteConnectionsDeleteTargets(context),
    // Prepared photo copies (docs/design/photo-embeddings.md). Named on its
    // own because OLYMPUS_MEDIA_CACHE_DIR or XDG_DATA_HOME can put it outside
    // the known roots; it is always a directory Olympus created for itself.
    ...mediaCacheDeleteTargets(context),
    ...knownOlympusDataRoots(context).map((path): DeleteTarget => ({
      path,
      kind: 'known_root',
      allowRecursive: true,
    })),
    // The folder of every account: inside the default data root it goes with
    // that root, but a relocated one (XDG_DATA_HOME, the Linux receipt) sits
    // outside the known roots. Named so nothing under it is left behind; the
    // data owner lock lives beside it, not inside, and stays.
    ...accountFoldersTargets(context),
    ...accountTrashTargets(context),
    serviceUnitTarget(workerServicePaths('darwin', home).unitPath),
    serviceUnitTarget(workerServicePaths('linux', home).unitPath),
    ...globExisting(join(home, 'Library', 'LaunchAgents'), /^(?:(?:com|org)\.openclaw\.olympus.*|ai\.olympusplugin\.engine)\.plist$/)
      .map(serviceUnitTarget),
    ...globExisting(join(home, '.config', 'systemd', 'user'), /^olympus.*\.(service|timer)$/)
      .map(serviceUnitTarget),
  ];
}

/**
 * `rmSync` of a delete target, except that the data owner lock stays: a
 * process may hold it (the CLI under its interim lock, the worker deleting
 * from the dashboard), and a new file under its name would be a different
 * lock that a second process could take. When the lock file sits inside a recursive target, everything else in
 * that target goes and the folders leading to the lock file stay; only
 * uninstall removes it, after everything else (docs/design/source-storage.md).
 */
function rmTargetKeepingOwnerLock(target: DeleteTarget, lockPath: string): void {
  const lock = canonicalPath(lockPath);
  const root = canonicalPath(target.path);
  if (!target.allowRecursive || !isStrictlyInside(lock, root) || !existsSync(lockPath)) {
    rmSync(target.path, { recursive: target.allowRecursive, force: true });
    return;
  }
  // The lock's path below the target: the folders to keep, then its own name.
  const keep = relative(root, lock).split(sep);
  const clear = (directory: string, depth: number): void => {
    const inLockDirectory = depth === keep.length - 1;
    for (const name of readdirSync(directory)) {
      const child = join(directory, name);
      if (inLockDirectory && isDataOwnerLockName(name)) continue;
      if (!inLockDirectory && name === keep[depth] && lstatSync(child).isDirectory()) {
        clear(child, depth + 1);
        continue;
      }
      rmSync(child, { recursive: true, force: true });
    }
  };
  clear(target.path, 0);
}

function mediaCacheDeleteTargets(context: LifecyclePathContext): DeleteTarget[] {
  try {
    return [{ path: mediaCacheDir(envForContext(context)), kind: 'known_root', allowRecursive: true }];
  } catch {
    return [];
  }
}

/**
 * Releases the media-cache copies the given connector stores reference (the
 * store's own reference marker, as LocalConnectorStore holds it: named by the
 * account and store the registry places it as, else by the store's real path,
 * whatever spelling of it this process was given) and
 * returns the copies removed, or those a dry run would release. A path is
 * checked to be a media-cache file by its shape, not against this process's
 * configured cache directory, which may differ from the worker's.
 *
 * Every store is read before anything is deleted or released: a store that
 * cannot be read stops the delete with every marker still in place.
 */
type SourceMediaHolds = Array<{
  storePath: string;
  holder: string;
  /** The store as the registry places it, when it does: its pictures are held under that too. */
  storeHolder: StoreHolder | undefined;
  rows: Array<{ media_path: string; media_sha256: string }>;
}>;

function readSourceMedia(sourceId: string, storePaths: readonly string[], env: LayoutEnv): SourceMediaHolds {
  const held: SourceMediaHolds = [];
  for (const storePath of storePaths) {
    if (storePath === ':memory:' || !existsSync(storePath)) continue;
    // A file that is not SQLite at all holds no references. One that is, and
    // cannot be read (corrupt, locked past the timeout), stops the delete:
    // deleting it would orphan its pictures' markers, so the sweep would
    // never remove those Private copies.
    if (!looksLikeSqlite(storePath)) continue;
    const unreadable = () => new OperationError(
      'invalid_params',
      `Cannot read the picture references in ${storePath}; nothing was deleted.`,
      'Stop the Olympus worker (olympus worker stop) so the store is not busy, or repair the store, then retry.',
    );
    let rows: Array<{ media_path: string; media_sha256: string }> = [];
    let db: Database;
    try {
      db = new Database(storePath, { readonly: true });
      db.exec('PRAGMA busy_timeout = 10000;');
    } catch {
      throw unreadable();
    }
    try {
      const columns = (db.query('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((column) => column.name);
      if (columns.includes('media_sha256')) {
        rows = db.query(`
          SELECT DISTINCT media_path, media_sha256 FROM chunks
          WHERE media_path IS NOT NULL AND media_sha256 IS NOT NULL
        `).all() as Array<{ media_path: string; media_sha256: string }>;
      }
    } catch {
      throw unreadable();
    } finally {
      closeSqliteStore(db);
    }
    // Named now, while the store exists: its real path is its marker's name,
    // and a deleted file has none.
    held.push({ storePath, holder: mediaHolderName(storePath), storeHolder: storeHolderAtPath(sourceId, storePath, env), rows });
  }
  return held;
}

function releaseSourceMedia(held: SourceMediaHolds, dryRun: boolean): string[] {
  const released: string[] = [];
  for (const { storePath, holder, storeHolder, rows } of held) {
    for (const row of rows) {
      if (!isMediaCachePath(row.media_path, row.media_sha256)) continue;
      if (dryRun) {
        if (existsSync(row.media_path)) released.push(row.media_path);
      } else {
        // Under the account and store it is, under its real path, and under
        // the path as given for a marker an earlier build named by its spelling.
        const removedByIdentity = storeHolder !== undefined
          && releaseMediaCacheFile(row.media_path, row.media_sha256, storeHolder);
        const removedByHolder = releaseMediaCacheFile(row.media_path, row.media_sha256, holder);
        const removedBySpelling = holder !== storePath
          && releaseMediaCacheFile(row.media_path, row.media_sha256, storePath);
        if (removedByIdentity || removedByHolder || removedBySpelling) released.push(row.media_path);
      }
    }
  }
  return released;
}

function looksLikeSqlite(path: string): boolean {
  try {
    const fd = openSync(path, 'r');
    try {
      const header = Buffer.alloc(16);
      const read = readSync(fd, header, 0, 16, 0);
      return read === 16 && header.toString('latin1') === 'SQLite format 3\u0000';
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function sourceDeleteTargets(source: LifecycleAccount, context: LifecyclePathContext): DeleteTarget[] {
  const { files } = source;
  const folder = files.folder;
  // A file inside the account's own folder is Olympus's by construction; the
  // folder itself is checked below.
  const inFolder = (path: string): boolean => folder !== undefined && isStrictlyInside(resolve(path), resolve(folder));
  const sqliteTargets = (path: string, storeId: string): DeleteTarget[] => sqliteDeleteTargets(path, storeId, context, inFolder(path));
  return [
    ...(files.preCutoverIndex ? sqliteTargets(files.preCutoverIndex.path, files.preCutoverIndex.storeId) : []),
    ...files.stores.flatMap((storePath) => [
      ...sqliteTargets(storePath, CONNECTOR_STORE_SQLITE_STORE_ID),
      // Each store's four-tier ledger is co-located with it (tier-ledger-path.ts),
      // so it is found wherever the store is — a *_DB_PATH override, XDG, the
      // WhatsApp state directory — and deleting a source takes its ledger rows.
      ...(storePath === ':memory:'
        ? []
        : sqliteTargets(tierLedgerPathForStore(storePath), TIER_LEDGER_SQLITE_STORE_ID)),
      // A tiered store set keeps its secret-locations index (location only:
      // identity, locator, a scanned title, finding kinds) beside its
      // secure_local store, like the set ledger, so it goes with its source.
      ...(storePath === ':memory:'
        ? []
        : sqliteTargets(secretLocationsPathForStore(storePath), SECRET_LOCATIONS_SQLITE_STORE_ID)),
      // The sniffer's verdict cache and question queue sit beside it too; the
      // queue holds names and short excerpts, so it goes with the source.
      ...(storePath === ':memory:'
        ? []
        : sqliteTargets(tierSnifferPathForStore(storePath), TIER_SNIFFER_SQLITE_STORE_ID)),
    ]),
    ...files.rawDatabases.flatMap((state) => state.path === ':memory:'
      ? []
      : sqliteTargets(state.path, state.storeId)),
    // Raw state inside the account's folder goes with the folder.
    ...files.raw.filter((path) => !inFolder(path)).map((path): DeleteTarget => ({
      path,
      kind: 'source_state_path',
      // Spool and media are directories; the sole point of naming them is to
      // take the message history inside them.
      allowRecursive: true,
      externalSourcePath: !isInsideRawStateRoot(path, context),
    })),
    ...files.settings.map((path): DeleteTarget => ({
      path,
      kind: 'policy_file',
      allowRecursive: false,
    })),
    // Last, so each store above is reported on its own and the folder takes
    // whatever else the account kept: raw state, lock files, empty folders.
    ...(folder ? [accountFolderTarget(folder, context)] : []),
  ];
}

/** The `<data>/sources` folder, when a relocated data root puts it outside every known root. */
function accountFoldersTargets(context: LifecyclePathContext): DeleteTarget[] {
  const root = accountFoldersRoot(envForContext(context));
  return isInsideKnownOlympusRoot(root, context) ? [] : [accountFolderTarget(root, context)];
}

/** `<data>/.trash`, where a per-source delete renames an account's folder, when it is outside every known root. */
function accountTrashTargets(context: LifecyclePathContext): DeleteTarget[] {
  const root = accountTrashRoot(envForContext(context));
  return isInsideKnownOlympusRoot(root, context) ? [] : [accountFolderTarget(root, context)];
}

/** The registry, when it is outside every known root (a relocated data folder). */
function registryDeleteTargets(context: LifecyclePathContext): DeleteTarget[] {
  const path = sourceRegistryPath(envForContext(context));
  return isInsideKnownOlympusRoot(path, context) ? [] : [{ path, kind: 'registry_file', allowRecursive: false }];
}

function accountFolderTarget(path: string, context: LifecyclePathContext | undefined): DeleteTarget {
  return { path, kind: 'account_folder', allowRecursive: true, ownedRoot: olympusDataRoot(envForContext(context)) };
}

/**
 * The connection database, its sidecars, and its pre-migration backup; and
 * the waiting private questions beside it (core/waiting-private-questions.ts),
 * which name those connections.
 */
function remoteConnectionsDeleteTargets(context: LifecyclePathContext): DeleteTarget[] {
  const dbPath = resolveRemoteConnectionsDbPath(envForContext(context));
  const targets = sqliteDeleteTargets(dbPath, REMOTE_CONNECTIONS_STORE_ID, context);
  return [
    ...targets,
    { ...targets[1]!, path: remoteConnectionsPreV2BackupPath(dbPath) },
    ...sqliteDeleteTargets(waitingPrivateQuestionsDbPath(dbPath), WAITING_PRIVATE_QUESTIONS_STORE_ID, context),
  ];
}

function sqliteDeleteTargets(
  sqlitePath: string,
  sqliteStoreId: string,
  context: LifecyclePathContext,
  /** Inside the account's own folder: Olympus's by construction, never an external path. */
  inAccountFolder = false,
): DeleteTarget[] {
  const externalSourcePath = !inAccountFolder && !isInsideKnownOlympusRoot(sqlitePath, context);
  return [
    {
      path: sqlitePath,
      kind: 'source_sqlite',
      sqliteStoreId,
      sqlitePrimaryPath: sqlitePath,
      allowRecursive: false,
      externalSourcePath,
    },
    {
      path: `${sqlitePath}-wal`,
      kind: 'source_sqlite_sidecar',
      sqliteStoreId,
      sqlitePrimaryPath: sqlitePath,
      allowRecursive: false,
      externalSourcePath,
    },
    {
      path: `${sqlitePath}-shm`,
      kind: 'source_sqlite_sidecar',
      sqliteStoreId,
      sqlitePrimaryPath: sqlitePath,
      allowRecursive: false,
      externalSourcePath,
    },
  ];
}

/**
 * An account the boot migration is part way through moving has some files at
 * the old place and some in its account folder, and the paths an export reads
 * name only one of them: an export now would leave stores out and still call
 * itself complete, and a Delete after it would lose them. So it is refused, and
 * so is an export when the registry cannot be read, since then a move cannot be
 * ruled out. Nothing has been written when it refuses.
 */
function refuseExportDuringMove(selected: readonly LifecycleAccount[], options: LifecyclePathContext): void {
  const own = new Set(selected.flatMap((source) => [source.sourceId, ...source.aliases]));
  let moving: string[];
  try {
    moving = readSourceRegistry(envForContext(options)).accounts
      .filter((account) => own.has(account.source_id) && sourceAccountMovePending(account))
      .map((account) => account.source_id);
  } catch (error) {
    if (!(error instanceof SourceRegistryError)) throw error;
    throw new OperationError(
      'source_index_error',
      `${error.message} Whether an account is part way through moving into its folder cannot be told, so nothing was exported.`,
      'Repair or restore that file, then export again.',
    );
  }
  if (moving.length === 0) return;
  throw new OperationError(
    'invalid_params',
    `${[...new Set(moving)].join(', ')} ${moving.length === 1 ? 'is' : 'are'} part way through moving into ${moving.length === 1 ? 'its' : 'their'} account folder, so an export now would leave files out; nothing was exported.`,
    'Start Olympus so it can finish the move or put the files back, then export again. If the move is stuck, its row in Needs you says why.',
  );
}

/**
 * What an export takes: the one account asked for, else every account that
 * exists (the registry's, and any with files but no entry yet). An account
 * being deleted is not exported: its data is on its way out.
 */
function selectExportAccounts(sourceId: string | undefined, context: LifecyclePathContext): LifecycleAccount[] {
  if (!sourceId) return existingAccounts(context);
  const account = requireAccount(sourceId, context);
  if (account.entry && account.entry.state !== 'active') {
    throw new OperationError(
      'invalid_params',
      `${account.sourceId}'s data is being deleted, so it was not exported.`,
      'Its data goes when Olympus next starts; there is nothing left to export.',
    );
  }
  return [account];
}

/** The source an id or alias names, or an error that lists the ones Olympus knows. */
export function requireSource(sourceId: string | undefined): { sourceId: string } {
  const normalized = requirePath(sourceId, '--source');
  const known = lifecycleSourceFor(normalized);
  if (!known) {
    throw new OperationError(
      'invalid_params',
      `Unknown Olympus source id "${normalized}".`,
      `Use one of: ${lifecycleSourceIds().join(', ')}.`,
    );
  }
  return { sourceId: known };
}

function requireAccount(sourceId: string | undefined, context: LifecyclePathContext): LifecycleAccount {
  return lifecycleAccountOf(requireSource(sourceId).sourceId, context);
}

/**
 * Exports one SQLite store as a verified, crash-durable snapshot.
 *
 * A file copy of the main database plus its sidecars is not a snapshot. A
 * checkpoint running between the two copies installs already-committed pages
 * into the live main file and resets the WAL, so the exported pair can omit a
 * transaction that committed BEFORE the export started — and the manifest
 * still reports success. `VACUUM INTO` asks SQLite for the snapshot instead:
 * one consolidated file produced under a read transaction, with the WAL folded
 * in rather than raced. The sidecars therefore have nothing left to carry.
 *
 * A declared store that exists but is not a readable SQLite database fails
 * closed. A byte copy of corrupt or encrypted bytes is not a verified
 * preservation snapshot and must not be reported as one.
 */
function exportSqliteStore(options: {
  sqlitePath: string;
  destinationRoot: string;
  exportRoot: string;
  sourceId: string;
  role: 'legacy_store' | 'connector_store';
  expectedStoreId: string;
  files: string[];
  skipped: string[];
  artifacts: DataExportArtifact[];
}): void {
  const { sqlitePath, destinationRoot, exportRoot, sourceId, role, expectedStoreId, files, skipped, artifacts } = options;
  if (!existsSync(sqlitePath)) {
    for (const path of sqliteWithSidecars(sqlitePath)) skipped.push(path);
    return;
  }
  const destination = join(destinationRoot, basename(sqlitePath));
  const staging = `${destination}.${randomUUID()}.partial`;
  if (snapshotSqliteStore(sqlitePath, staging)) {
    let sqlite: NonNullable<DataExportArtifact['sqlite']>;
    try {
      sqlite = inspectSqliteSnapshot(staging, sqlitePath, expectedStoreId);
      syncFileSync(staging);
      renameSync(staging, destination);
    } catch (error) {
      rmSync(staging, { force: true });
      throw error;
    }
    syncDirectorySync(dirname(destination));
    files.push(destination);
    artifacts.push({
      ...fileArtifact(exportRoot, destination, sourceId, role),
      sqlite,
    });
    return;
  }
  throw new OperationError(
    'source_index_error',
    `Declared Olympus SQLite store is not a readable database: ${sqlitePath}`,
    'The export failed closed; repair or explicitly account for the store before transition.',
  );
}

/**
 * Returns false — leaving nothing behind — when the path is not a database
 * SQLite can snapshot. Every other failure is a durability failure and reaches
 * the caller.
 */
function snapshotSqliteStore(sqlitePath: string, staging: string): boolean {
  rmSync(staging, { force: true });
  let db: Database;
  try {
    db = new Database(sqlitePath, { readonly: true });
  } catch {
    return false;
  }
  try {
    db.exec('PRAGMA busy_timeout = 10000;');
    db.exec(`VACUUM INTO '${sqliteStringLiteral(staging)}'`);
  } catch (error) {
    rmSync(staging, { force: true });
    if (isUnreadableSqliteError(error)) return false;
    throw new OperationError(
      'source_index_error',
      `Failed to snapshot Olympus SQLite store for export: ${sqlitePath}`,
      'Retry the export once the store is readable; no partial snapshot was published.',
    );
  } finally {
    closeSqliteStore(db);
  }
  return true;
}

function assertSqliteSnapshotIntact(snapshotPath: string, sqlitePath: string): void {
  inspectSqliteSnapshot(snapshotPath, sqlitePath, 'unknown');
}

function inspectSqliteSnapshot(
  snapshotPath: string,
  sqlitePath: string,
  expectedStoreId: string,
): NonNullable<DataExportArtifact['sqlite']> {
  const db = new Database(snapshotPath, { readonly: true });
  try {
    // busy_timeout leads, before the integrity check takes a read lock. The
    // staging snapshot is ours alone, but the rule is the connection's, not the
    // file's: an open with no timeout fails instantly on any contention it does
    // meet, and one exempt open is what licenses the next.
    db.exec('PRAGMA busy_timeout = 10000;');
    const rows = db.query('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      throw new OperationError(
        'source_index_error',
        `Olympus SQLite export snapshot failed its integrity check: ${sqlitePath}`,
        'The snapshot was discarded rather than published; retry the export.',
      );
    }
    const foreignKeyRows = db.query('PRAGMA foreign_key_check').all();
    if (foreignKeyRows.length > 0) {
      throw new OperationError(
        'source_index_error',
        `Olympus SQLite export snapshot failed its foreign-key check: ${sqlitePath}`,
        'The snapshot was discarded rather than published; repair the store before transition.',
      );
    }
    const schemaVersion = expectedStoreId === 'unknown' ? 0 : readSqliteSchemaVersion(db, expectedStoreId);
    return {
      integrityCheck: 'ok',
      foreignKeyViolations: foreignKeyRows.length,
      expectedStoreId,
      schemaVersion,
    };
  } finally {
    closeSqliteStore(db);
  }
}

function fileArtifact(
  exportRoot: string,
  path: string,
  sourceId: string,
  role: DataExportArtifact['role'],
): DataExportArtifact {
  const stats = statSync(path);
  return {
    sourceId,
    role,
    relativePath: relative(resolve(exportRoot), resolve(path)),
    bytes: stats.size,
    sha256: sha256File(path),
  };
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function parseExportArtifact(value: unknown): DataExportArtifact {
  if (!value || typeof value !== 'object') {
    throw new OperationError('source_index_error', 'Olympus data export manifest contains an invalid artifact.');
  }
  const artifact = value as Partial<DataExportArtifact>;
  if (typeof artifact.relativePath !== 'string'
    || artifact.relativePath.length === 0
    || typeof artifact.bytes !== 'number'
    || !Number.isSafeInteger(artifact.bytes)
    || artifact.bytes < 0
    || typeof artifact.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new OperationError('source_index_error', 'Olympus data export manifest contains an invalid artifact.');
  }
  return artifact as DataExportArtifact;
}

/**
 * `VACUUM INTO` takes an SQL string literal, not a bound parameter, so the one
 * character that can end it is doubled. The path is Olympus-derived rather
 * than attacker-supplied, but a destination directory with an apostrophe in it
 * would otherwise produce a syntax error at export time.
 */
function sqliteStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function isUnreadableSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('not a database') || message.includes('file is encrypted');
}

function sqliteWithSidecars(sqlitePath: string): string[] {
  return [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`];
}

function copySanitizedJsonIfPresent(source: string, destination: string, files: string[], skipped: string[]): boolean {
  if (!existsSync(source)) {
    skipped.push(source);
    return false;
  }
  const parsed = JSON.parse(readFileSync(source, 'utf8')) as unknown;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(destination, JSON.stringify(sanitizeForExport(parsed), null, 2));
  files.push(destination);
  return true;
}

/**
 * The deepest directory the export will NOT create, which is where the fsync
 * walk has to stop.
 *
 * `mkdir -p` creates grandparents too. Stopping at the destination's parent
 * flushed that parent but never the directory holding ITS entry, so a
 * first-time or dated backup target — `--output ~/exports/olympus/2026-08-18`
 * with `~/exports/olympus` absent — fsynced every snapshot and the manifest
 * into a chain whose top link had never reached the disk. A power loss then
 * took the whole export, which is the one outcome the fsyncs below exist to
 * prevent. Exported because the boundary is not observable from the exported
 * tree; a test pins it.
 */
export function exportDurabilityBoundary(destination: string): string {
  let current = dirname(resolve(destination));
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Creates a directory chain and flushes every level of it, up to and including
 * `boundary`. A file that was fsynced into a directory whose own entry never
 * reached the disk is still gone after a power loss, so the export's
 * directories are made durable before anything is written into them.
 */
function makeDurableDirectory(path: string, boundary: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  let current = resolve(path);
  for (;;) {
    syncDirectorySync(current);
    if (current === boundary) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function syncFileSync(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectorySync(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    closeSync(descriptor);
  }
}

function sanitizeForExport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForExport);
  if (typeof value === 'string' && containsPrivateKeyBlock(value)) return '[redacted_secret]';
  if (!value || typeof value !== 'object') return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    sanitized[key] = sanitizeForExport(child);
  }
  return sanitized;
}

function isSecretKey(key: string): boolean {
  if (key === 'secretRef') return false;
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'secret'
    || normalized === 'token'
    || normalized === 'authtoken'
    || normalized === 'accesstoken'
    || normalized === 'refreshtoken'
    || normalized === 'apikey'
    || normalized === 'clientsecret'
    || normalized === 'password'
    || normalized === 'privatekey'
    || normalized === 'serviceaccountjson'
    || normalized === 'credential'
    || normalized === 'credentials') {
    return true;
  }
  const lowered = key.toLowerCase();
  return lowered === 'secret'
    || lowered.includes('authtoken')
    || lowered.includes('access_token')
    || lowered.includes('refreshtoken')
    || lowered.includes('refresh_token')
    || lowered.includes('apikey')
    || lowered.includes('api_key')
    || lowered.includes('clientsecret')
    || lowered.includes('client_secret')
    || lowered.includes('password')
    || lowered === 'token';
}

function containsPrivateKeyBlock(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

function globExisting(root: string, pattern: RegExp): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((path) => {
      const name = basename(path);
      return pattern.test(name) && statSync(path).isFile();
    });
}

function serviceUnitTarget(path: string): DeleteTarget {
  return {
    path,
    kind: 'service_unit',
    allowRecursive: false,
  };
}

function assertDeleteTargetSafe(target: DeleteTarget): void {
  if (target.kind === 'source_state_path') {
    // Raw state carries no Olympus schema marker to verify, so a state
    // directory an operator has pointed outside every Olympus root cannot be
    // proven ours. Refusing before anything is removed is the only honest
    // answer: a recursive delete of a stranger's directory is unrecoverable,
    // and a silent skip is the false completion this target exists to end.
    if (target.externalSourcePath === true) {
      throw new OperationError(
        'invalid_params',
        `Refusing to delete source state outside an Olympus-owned root: ${target.path}`,
        'Check the configured state-directory value (the OLYMPUS_* state, spool and media folder overrides), then remove that directory by hand.',
      );
    }
    return;
  }

  if (target.kind === 'account_folder') {
    assertAccountFolderOwned(target);
    return;
  }

  if (target.kind === 'known_root') {
    if (!lstatSync(target.path).isDirectory()) {
      throw new OperationError(
        'invalid_params',
        `Refusing to recursively delete non-directory Olympus root: ${target.path}`,
      );
    }
    return;
  }

  assertRegularFileTarget(target.path);
  if (target.externalSourcePath === true) {
    const primaryPath = target.sqlitePrimaryPath ?? target.path;
    assertVerifiedExternalSqliteStore(primaryPath, target.sqliteStoreId);
  }
}

/**
 * A folder under `<data>/sources` may be removed recursively only when it is
 * provably Olympus's: a real directory (not a link), strictly inside
 * `<data>/sources`, with no link between the data root and the folder. A link
 * means the owner pointed Olympus at storage it may not own, so we refuse
 * before anything is removed rather than delete through it.
 */
function assertAccountFolderOwned(target: DeleteTarget): void {
  const refuse = (why: string): never => {
    throw new OperationError(
      'invalid_params',
      `Refusing to delete the account folder ${why}: ${target.path}`,
      'Check the Olympus data folder, then remove that folder by hand. Nothing was deleted.',
    );
  };
  const owned = target.ownedRoot ? resolve(target.ownedRoot) : undefined;
  const lexical = resolve(target.path);
  // The sources folder, or the trash a deleted account's folder is renamed into.
  const inside = (name: string): boolean => {
    const folder = join(owned!, name);
    return lexical === folder || isStrictlyInside(lexical, folder);
  };
  if (!owned || !(inside(ACCOUNT_FOLDERS_DIR) || inside(ACCOUNT_TRASH_DIR))) {
    refuse('because it is not inside the Olympus sources folder');
  }
  if (!lstatSync(target.path).isDirectory()) refuse('because it is not a folder (it may be a symbolic link)');
  if (canonicalPath(lexical) !== join(canonicalPath(owned!), relative(owned!, lexical))) {
    refuse('because it, or a folder above it, is a symbolic link');
  }
}

function assertRegularFileTarget(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new OperationError(
      'invalid_params',
      `Refusing to delete non-file target outside an Olympus-owned root: ${path}`,
    );
  }
}

function assertVerifiedExternalSqliteStore(path: string, storeId: string | undefined): void {
  if (!storeId) {
    throw new OperationError('invalid_params', `Refusing to delete external SQLite path without a store id: ${path}`);
  }
  assertRegularFileTarget(path);
  let db: Database;
  try {
    db = new Database(path, { readonly: true, create: false });
    db.exec('PRAGMA busy_timeout = 10000;');
  } catch {
    throw new OperationError(
      'invalid_params',
      `Refusing to delete external source path that is not a readable Olympus SQLite store: ${path}`,
      'Check the configured OLYMPUS_*_DB_PATH value before retrying data deletion.',
    );
  }
  try {
    let schemaVersion = 0;
    try {
      schemaVersion = readSqliteSchemaVersion(db, storeId);
    } catch {
      throw new OperationError(
        'invalid_params',
        `Refusing to delete external source path that is not a readable Olympus SQLite store: ${path}`,
        'Check the configured OLYMPUS_*_DB_PATH value before retrying data deletion.',
      );
    }
    if (schemaVersion <= 0) {
      throw new OperationError(
        'invalid_params',
        `Refusing to delete external SQLite store without Olympus schema marker "${storeId}": ${path}`,
        'Run data delete only after confirming the configured path belongs to Olympus.',
      );
    }
  } finally {
    closeSqliteStore(db);
  }
}

/** Nearest existing ancestor's real path plus the not-yet-existing remainder. */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

function isStrictlyInside(path: string, root: string): boolean {
  return path !== root && path.startsWith(`${root}${sep}`);
}

/**
 * The safety rules for a RECURSIVE raw-state delete target (spool, media,
 * gateway state: whatever an env override or a default names).
 *
 * 1. Strictly inside an Olympus root, never equal to one and never above one: an
 *    override such as OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR=~/.local/share/olympus
 *    would otherwise turn one source's delete into every source's.
 * 2. No symlink anywhere between the root and the target, the target itself
 *    included: the real path must equal the lexical path under the root's real
 *    path. A symlinked raw directory would otherwise send a recursive delete
 *    into whatever it points at. We REFUSE rather than delete only the link,
 *    because a link there means the owner pointed Olympus at storage it may
 *    not own, and silently removing the link would still report a delete that
 *    left the data in place.
 * 3. (One source's delete) it must not equal, contain or sit inside any other
 *    source's delete target, any login or pairing path, or the shared config,
 *    registry, connections and media-cache paths.
 * Symlinks NESTED inside a valid target are not followed: rmSync unlinks them
 * (pinned by a test), so what they point at survives.
 * Refusing happens before anything is removed.
 */
function assertRawStateTargetsContained(
  targets: readonly DeleteTarget[],
  context: LifecyclePathContext & { handleRegistryPath?: string },
  selectedSource: LifecycleAccount | undefined,
): void {
  const stateTargets = targets.filter((target) => target.kind === 'source_state_path' && target.allowRecursive);
  // One source's delete also takes its whole account folder recursively, which
  // is held to the same overlap rule (3): no other source's path may sit in it.
  const overlapTargets = selectedSource
    ? [...stateTargets, ...targets.filter((target) => target.kind === 'account_folder')]
    : stateTargets;
  if (overlapTargets.length === 0) return;
  const roots = rawStateRoots(context).map((root) => ({ lexical: resolve(root), real: canonicalPath(root) }));
  const refuse = (path: string, why: string): never => {
    throw new OperationError(
      'invalid_params',
      `Refusing to delete source state ${why}: ${path}`,
      'Check the configured state-directory values, then remove that directory by hand. Nothing was deleted.',
    );
  };
  for (const target of stateTargets) {
    const lexical = resolve(target.path);
    const root = roots.find((candidate) => isStrictlyInside(lexical, candidate.lexical));
    if (!root) {
      // Equal to a root, above one, or outside all of them. Outside is the
      // external fence's job (it names the override); equal or above is ours.
      if (roots.some((candidate) => lexical === candidate.lexical || isStrictlyInside(candidate.lexical, lexical))) {
        refuse(target.path, 'that is, or contains, an Olympus data root');
      }
      continue;
    }
    const expectedReal = join(root.real, relative(root.lexical, lexical));
    if (canonicalPath(lexical) !== expectedReal) refuse(target.path, 'because it, or a directory above it, is a symbolic link');
  }
  if (!selectedSource) return;
  const home = resolveHome(context.homeDir);
  const own = new Set([selectedSource.sourceId, ...selectedSource.aliases]);
  const protectedPaths = new Set<string>();
  for (const other of knownAccounts(context)) {
    if (own.has(other.sourceId)) continue;
    for (const path of sourceDeleteTargets(other, context).map((target) => target.path)) protectedPaths.add(path);
    for (const path of other.files.preserved) protectedPaths.add(path);
    for (const path of other.files.pairing ?? []) protectedPaths.add(path);
  }
  for (const path of selectedSource.files.preserved) protectedPaths.add(path);
  // A legacy account's grant keeps the path its session was paired at, which an override lifted since
  // no longer names: it may be inside an account folder this delete is about to take. A grant that exists
  // but cannot be read says nothing, so another account's delete is refused rather than risk its session.
  for (const grant of retainedCaptureGrants(handleRegistryPathFor(context))) {
    if (grant.evidence.kind === 'path') {
      for (const path of pairingSessionPathsFromStoredValue(grant.source, grant.evidence.sessionPath)) protectedPaths.add(path);
    } else if (grant.evidence.kind === 'unreadable' && !own.has(grant.sourceId)) {
      throw new OperationError(
        'invalid_params',
        `Refusing to delete source state because the ${grant.label} capture grant cannot be read, so it cannot be shown that its session is outside what this delete removes.`,
        'Fix or remove that grant (unpair the account), then delete again. Nothing was deleted.',
      );
    }
  }
  // A store the connector-store mount list places by path (Reflect, Roam, an
  // operator's own) may sit anywhere, an account folder included: another
  // source's mounted store and its sidecars are protected where they really are.
  const mounts = declaredConnectorStoreMounts(envForContext(context));
  if (mounts === 'unreadable' && overlapTargets.some((target) => target.kind === 'account_folder')) {
    throw new OperationError(
      'invalid_params',
      'Refusing to delete the account folder because OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON cannot be read, so the stores it places cannot be told apart from this account\'s.',
      'Fix that setting, then delete again. Nothing was deleted.',
    );
  }
  for (const mount of mounts === 'unreadable' ? [] : mounts) {
    if (own.has(mount.sourceId) || !mount.dbPath || mount.dbPath === ':memory:') continue;
    for (const path of [
      mount.dbPath,
      tierLedgerPathForStore(mount.dbPath),
      secretLocationsPathForStore(mount.dbPath),
      tierSnifferPathForStore(mount.dbPath),
    ]) protectedPaths.add(path);
  }
  for (const path of [
    join(home, '.olympus', 'config.json'),
    defaultSovereigntyConfigPathForHome(context.homeDir),
    join(home, '.config', 'olympus', 'handles.json'),
    join(home, '.config', 'olympus', 'handles.json.unpaired'),
    ...remoteConnectionsDeleteTargets(context).map((target) => target.path),
    ...mediaCacheDeleteTargets(context).map((target) => target.path),
  ]) protectedPaths.add(path);
  const protectedCanonical = [...protectedPaths].flatMap((path) => [resolve(path), canonicalPath(path)]);
  for (const target of overlapTargets) {
    const candidates = [resolve(target.path), canonicalPath(target.path)];
    for (const protectedPath of protectedCanonical) {
      for (const candidate of candidates) {
        if (candidate === protectedPath || isStrictlyInside(protectedPath, candidate) || isStrictlyInside(candidate, protectedPath)) {
          // A target legitimately inside its OWN source's other path is not
          // reachable here: own paths are not in the protected set.
          if (target.kind === 'account_folder') {
            // Typically another source's retained path override (a legacy
            // account pinned by OLYMPUS_*_DB_PATH) pointing into this folder.
            throw new OperationError(
              'invalid_params',
              `Refusing to delete the account folder because it overlaps another source's or shared Olympus data (${protectedPath}): ${target.path}`,
              'Check the OLYMPUS_* path overrides, move that data out of this folder or remove the folder by hand. Nothing was deleted.',
            );
          }
          refuse(target.path, `because it overlaps another source's or shared Olympus data (${protectedPath})`);
        }
      }
    }
  }
}

/**
 * Everything a delete reaches under `<data>/sources` (the account folders) is
 * reached through no link, the target itself included and every directory
 * between the data root and it: the real path must equal the lexical path
 * under the data root's real path. `stores` of one account linked to another
 * account's `stores` would otherwise send the per-file removals, which pass
 * their own checks as regular files, into the other account. The account
 * folder targets have their own check (assertAccountFolderOwned). Runs for
 * every target before anything is removed; a refusal deletes nothing.
 */
function assertSourcesFolderTargetsUnlinked(targets: readonly DeleteTarget[], context: LifecyclePathContext): void {
  const env = envForContext(context);
  const owned = resolve(olympusDataRoot(env));
  const sources = resolve(accountFoldersRoot(env));
  const ownedReal = canonicalPath(owned);
  for (const target of targets) {
    if (target.kind === 'account_folder') continue;
    const lexical = resolve(target.path);
    if (!isStrictlyInside(lexical, sources)) continue;
    if (canonicalPath(lexical) !== join(ownedReal, relative(owned, lexical))) {
      throw new OperationError(
        'invalid_params',
        `Refusing to delete inside the account folders because it, or a folder above it, is a symbolic link: ${target.path}`,
        'Check the Olympus data folder, then remove what the link points at by hand. Nothing was deleted.',
      );
    }
  }
}

function isInsideKnownOlympusRoot(path: string, context: LifecyclePathContext): boolean {
  return knownOlympusDataRoots(context).some((root) => isSameOrInsidePath(path, root));
}

/**
 * The roots a raw-state delete (spool, media, gateway state) may reach: the
 * known roots, and where the data and capture state really are when that is
 * not under the home (a relocated XDG data or state home, a standalone Linux
 * engine's data folder). Each is a folder Olympus names, so a path outside
 * all of them is still the external fence's refusal. Not `knownOlympusDataRoots`,
 * which `delete --all` removes recursively and which must not grow.
 */
function rawStateRoots(context: LifecyclePathContext): string[] {
  return pairingOwnedRoots({ ...(context.homeDir ? { homeDir: context.homeDir } : {}), env: envForContext(context) });
}

function isInsideRawStateRoot(path: string, context: LifecyclePathContext): boolean {
  return rawStateRoots(context).some((root) => isSameOrInsidePath(path, root));
}

function isSameOrInsidePath(path: string, root: string): boolean {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(root);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${sep}`);
}

function defaultSovereigntyConfigPathForHome(homeDir: string | undefined): string {
  if (!homeDir || process.platform === 'linux') return defaultSovereigntyConfigPath(envForHome(homeDir));
  return join(homeDir, '.olympus', 'sovereignty.json');
}

function envForHome(homeDir: string | undefined): Record<string, string | undefined> {
  if (!homeDir) return process.env;
  return {
    HOME: homeDir,
    XDG_DATA_HOME: join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: join(homeDir, '.local', 'state'),
  };
}

function envForContext(context: LifecyclePathContext | undefined): Record<string, string | undefined> {
  if (!context?.env) return envForHome(context?.homeDir);
  if (!context.homeDir) return context.env;
  return { ...envForHome(context.homeDir), ...context.env };
}

function resolveHome(homeDir: string | undefined): string {
  return homeDir?.trim() || homedir();
}

function requirePath(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new OperationError('invalid_params', `${name} must be provided.`);
  return value.trim();
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function uniqueTargets(values: DeleteTarget[]): DeleteTarget[] {
  const byPath = new Map<string, DeleteTarget>();
  for (const value of values) {
    const existing = byPath.get(value.path);
    if (!existing || (existing.kind !== 'known_root' && value.kind === 'known_root')) {
      byPath.set(value.path, value);
    }
  }
  return [...byPath.values()];
}

export function relativeLifecyclePaths(paths: string[], root: string): string[] {
  return paths.map((path) => relative(root, path)).sort();
}
