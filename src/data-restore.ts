/**
 * `olympus data restore --input <dir>`: put an export back onto a fresh
 * install (#1065).
 *
 * An export (src/data-lifecycle.ts) holds each account's connector stores
 * with their tier sidecars (the privacy judgments), and the owner's own
 * settings and rules. A restore checks the export first, refuses to write
 * over anything this computer already holds, puts each file where this
 * install keeps it, and names the sources to sign in to again: sign-ins and
 * session secrets are never in an export, so they never come back.
 *
 * Embeddings travel inside the stores, with the model identity that made
 * them, and judgments travel in the tier ledgers beside them, so an install
 * running the same models neither embeds nor judges again.
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EXPORT_MEDIA_DIR,
  exportDurabilityBoundary,
  lifecycleAccountFiles,
  lifecycleEnv,
  lifecycleHandleRegistryPath,
  lifecycleStoreLayouts,
  makeDurableDirectory,
  verifyOlympusDataExport,
  type DataExportArtifact,
  type LifecyclePathContext,
} from './data-lifecycle.ts';
import { OperationError } from './core/operation-error.ts';
import { syncDirectorySync } from './core/atomic-file.ts';
import { defaultSovereigntyConfigPath } from './core/sovereignty.ts';
import {
  secretLocationsPathForStore,
  tierLedgerPathForStore,
  tierSnifferPathForStore,
} from './workers/classification/tier-ledger-path.ts';
import { resolveTierRulesPath } from './workers/classification/tier-rules.ts';
import { resolveSourceIngestionExclusionsPath } from './workers/source-dispositions.ts';
import { Database } from 'bun:sqlite';
import { closeSqliteStore } from './core/sqlite-store.ts';
import { mediaCacheDir, retainMediaCacheFile } from './core/media-cache.ts';
import {
  ACCOUNT_BOUND_SOURCE_IDS,
  readSourceAccountBindings,
  sourceAccountBindingsPath,
  SourceAccountBindingsUnreadableError,
  updateSourceAccountBinding,
  type AccountBoundSourceId,
} from './core/source-account-binding.ts';
import { compareProviderAccounts, mergeProviderAccountIds } from './core/provider-account-identity.ts';
import { DEFAULT_ACCOUNT_SLOT, findRegistryAccount, readSourceRegistry } from './core/source-registry.ts';
import { placeOwnedAccount, recordProviderAccount } from './core/source-storage.ts';
import { carryMailOwnerRules, defaultMailSourceScopeStatePath, normalizeSenders } from './core/mail-source-scope.ts';
import { TIER_SET_BINDING_CONNECTOR_ID, TIER_SET_BINDING_RUN_ID } from './workers/connector-store/local-index.ts';
import { TierLedger } from './workers/classification/tier-ledger.ts';
import { TIER_LEDGER_FILE_SUFFIX } from './workers/classification/tier-ledger-path.ts';

export interface DataRestorePlanEntry {
  /** The file in the export, relative to it. */
  from: string;
  /** Where this install keeps it. */
  to: string;
  sourceId: string;
  kind: 'store' | 'judgments' | 'owner_settings' | 'media';
  /** An owner settings file this computer already has: kept beside the restored one. */
  keptAs?: string;
  /** Merged into the file at `to` rather than copied over it (the mail picker's "always Private" senders). */
  merge?: 'mail_always_private';
}

export interface DataRestoreResult {
  ok: true;
  input: string;
  dryRun: boolean;
  exportVersion: number;
  sourceIds: string[];
  restored: DataRestorePlanEntry[];
  /** Every restored source needs its sign-in again: an export never holds one. */
  signInAgain: string[];
  notes: string[];
}

interface ManifestShape {
  version: number;
  source_ids?: unknown;
  /** Version 3: each account's layout and, when known, which provider account its items came from. */
  accounts?: unknown;
  artifacts: DataExportArtifact[];
}

/** Which provider account a restored source's items came from, as the backup records it. */
interface RestoredAccountIdentity {
  sourceId: string;
  /** The source registry's history account (provider_account_hash). */
  historyAccount?: string;
  /** The account binding's account, for a source bound to one provider account. */
  boundAccount?: string;
  previousAccountFolders?: string[];
}

export function restoreOlympusData(options: { input: string; dryRun?: boolean } & LifecyclePathContext): DataRestoreResult {
  const input = resolve(options.input);
  // Every byte is checked against the manifest before anything is written.
  verifyOlympusDataExport({ destination: input });
  const manifest = JSON.parse(readFileSync(join(input, 'manifest.json'), 'utf8')) as ManifestShape;
  const context: LifecyclePathContext = {
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
  const env = lifecycleEnv(context);
  const notes: string[] = [];
  const plan: DataRestorePlanEntry[] = [];
  const storesBySource = new Map<string, string[]>();
  const storesOf = (sourceId: string): string[] => {
    let stores = storesBySource.get(sourceId);
    if (!stores) {
      stores = lifecycleAccountFiles(sourceId, context).stores;
      storesBySource.set(sourceId, stores);
    }
    return stores;
  };
  const storeTarget = (artifact: DataExportArtifact): string => {
    const stores = storesOf(artifact.sourceId);
    if (artifact.storeIndex !== undefined) {
      const target = stores[artifact.storeIndex];
      if (target) return target;
    } else {
      // A version 2 export names a store only by its file name, as the
      // install that made it kept it (legacy or folder layout).
      const name = artifact.relativePath.split('/').pop();
      for (const layout of lifecycleStoreLayouts(artifact.sourceId, context)) {
        const index = layout.findIndex((path) => path.split('/').pop() === name);
        if (index >= 0 && stores[index]) return stores[index]!;
      }
    }
    throw new OperationError(
      'invalid_params',
      `This backup holds a ${artifact.sourceId} store this version of Olympus does not keep (${artifact.relativePath}).`,
      'Restore with the Olympus version that made the backup, then update.',
    );
  };

  let sawJudgments = false;
  for (const artifact of manifest.artifacts) {
    const from = artifact.relativePath;
    switch (artifact.role) {
      case 'connector_store':
        plan.push({ from, to: storeTarget(artifact), sourceId: artifact.sourceId, kind: 'store' });
        break;
      case 'tier_sidecar': {
        const store = storeTarget(artifact);
        const to = artifact.sidecar === 'tier_ledger' ? tierLedgerPathForStore(store)
          : artifact.sidecar === 'tier_sniffer' ? tierSnifferPathForStore(store)
            : artifact.sidecar === 'secret_locations' ? secretLocationsPathForStore(store)
              : undefined;
        if (!to) throw new OperationError('invalid_params', `The backup names an unknown file beside a store: ${from}.`);
        if (artifact.sidecar === 'tier_ledger') sawJudgments = true;
        plan.push({ from, to, sourceId: artifact.sourceId, kind: 'judgments' });
        break;
      }
      case 'media': {
        // A prepared picture, named by its digest: it goes into this install's
        // media cache under the same name, and the restored rows are pointed at it.
        const name = from.split('/').pop() ?? '';
        if (from !== `${EXPORT_MEDIA_DIR}/${name}` || name !== `${artifact.sha256}.jpg`) {
          throw new OperationError('invalid_params', `The backup names a picture that is not where a backup keeps one: ${from}.`);
        }
        plan.push({ from, to: join(mediaCacheDir(env), name), sourceId: artifact.sourceId, kind: 'media' });
        break;
      }
      case 'legacy_store':
        // A pre-1.0 per-family index: the stores beside it hold the same items
        // in today's layout, which is what an install opens.
        notes.push(`Left out ${from}: an index from before Olympus 1.0, which this install doesn't open.`);
        break;
      case 'owner_rules': {
        if (artifact.ownerFile === 'mail_always_private') {
          // Not a file of its own here: the senders go into the mail scope
          // file, beside an approval this computer may already hold.
          const to = defaultMailSourceScopeStatePath(lifecycleHandleRegistryPath(context));
          // Checked before anything is written: a list the picker would refuse is refused here.
          normalizeSenders((JSON.parse(readFileSync(join(input, from), 'utf8')) as { always_private_senders?: unknown }).always_private_senders, 'always Private');
          plan.push({ from, to, sourceId: 'olympus.config', kind: 'owner_settings', merge: 'mail_always_private' });
          break;
        }
        const to = artifact.ownerFile === 'tier_rules' ? resolveTierRulesPath({ env })
          : artifact.ownerFile === 'ingestion_exclusions' ? resolveSourceIngestionExclusionsPath(env)
            : undefined;
        if (!to) throw new OperationError('invalid_params', `The backup names an unknown settings file: ${from}.`);
        plan.push({ from, to, sourceId: 'olympus.config', kind: 'owner_settings' });
        break;
      }
      case 'sanitized_config':
        if (from.endsWith('config/sovereignty.json')) {
          plan.push({ from, to: sovereigntyPath(options.homeDir, env), sourceId: 'olympus.config', kind: 'owner_settings' });
        } else if (from.endsWith('config/config.json')) {
          // This install's own config holds its worker token and paths; the
          // backup's copy has neither, so it is never written over it.
          notes.push('Kept this computer\'s config.json: it holds this install\'s own connection settings.');
        } else {
          // A source's own settings (for example Dropbox's ingestion policy).
          plan.push({ from, to: sourceSettingsTarget(artifact, context), sourceId: artifact.sourceId, kind: 'owner_settings' });
        }
        break;
      default:
        throw new OperationError('invalid_params', `The backup holds a file this version of Olympus does not know: ${from}.`);
    }
  }
  // A store that already holds tier-routed copies is bound to the ledger that
  // judged them, and opens only beside that ledger. A backup that has such a
  // store without its ledger (version 2 exported none) cannot be judged again
  // into a new one, so it is refused before anything is written.
  const ledgerSources = new Set(plan.filter((entry) => entry.kind === 'judgments' && entry.to.endsWith(TIER_LEDGER_FILE_SUFFIX)).map((entry) => entry.sourceId));
  const unbound = plan.filter((entry) => entry.kind === 'store' && !ledgerSources.has(entry.sourceId) && storeIsTierBound(join(input, entry.from)));
  if (unbound.length > 0) {
    throw new OperationError(
      'invalid_params',
      `This backup holds ${[...new Set(unbound.map((entry) => entry.sourceId))].join(', ')} items that were judged into Private or Secret stores, but not the judgments themselves, so they could not be opened after a restore. Nothing was restored.`,
      'Make a new backup with this version of Olympus (olympus data export), then restore that one.',
    );
  }
  if (manifest.version < 3 || !sawJudgments) {
    notes.push('This backup has no privacy judgments, so Olympus judges the restored items again.');
  }

  // A restore never writes over data: an install that already holds a store
  // is not a fresh one, and merging two histories is not what was asked.
  // Every store and sidecar a restored source owns counts, not only the ones
  // in the backup: a backup with one tier's store must not land beside
  // another tier's store and ledger already here.
  const holds = (path: string): boolean => existsSync(path) && statSync(path).size > 0;
  const restoredSources = [...new Set(plan.filter((entry) => entry.kind !== 'owner_settings').map((entry) => entry.sourceId))];
  const occupiedSources = restoredSources.filter((sourceId) => storesOf(sourceId).some((store) => [
    store,
    tierLedgerPathForStore(store),
    tierSnifferPathForStore(store),
    secretLocationsPathForStore(store),
  ].some(holds)));
  if (occupiedSources.length > 0) {
    const sources = occupiedSources;
    throw new OperationError(
      'invalid_params',
      `This computer already holds Olympus data for ${sources.join(', ')}, so nothing was restored.`,
      'Restore onto a fresh install, or delete that data first with olympus data delete --source <id>.',
    );
  }
  for (const entry of plan) {
    if (entry.kind === 'owner_settings' && !entry.merge && existsSync(entry.to)) entry.keptAs = `${entry.to}.before-restore`;
  }

  const sourceIds = [...new Set(plan.filter((entry) => entry.kind === 'store').map((entry) => entry.sourceId))];
  // Which account each source's items came from, so signing in again to that
  // same account is recognized by the account guard and another account is
  // still caught. Checked against what this computer records before anything
  // is written; written once the files are in place.
  const identities = restoredAccountIdentities(manifest, sourceIds);
  const bindingsPath = sourceAccountBindingsPath(lifecycleHandleRegistryPath(context));
  checkRestoredIdentities(identities, bindingsPath, env);
  if (identities.length > 0) {
    notes.push(`Restored which account the items of ${identities.map((identity) => identity.sourceId).join(', ')} came from: sign in to that same account to carry on syncing.`);
  }
  if (!options.dryRun) {
    // A new account entry is placed before its files arrive, as at any first
    // connect, and must place them where the plan put them.
    for (const identity of identities) {
      if (!identity.historyAccount) continue;
      const layout = placeOwnedAccount({ sourceId: identity.sourceId, slot: DEFAULT_ACCOUNT_SLOT }, env);
      if (layout !== lifecycleAccountFiles(identity.sourceId, context).account.layout || !samePaths(storesOf(identity.sourceId), lifecycleAccountFiles(identity.sourceId, context).stores)) {
        throw new OperationError('invalid_params', `This install places ${identity.sourceId} somewhere other than the restore planned, so nothing was restored.`);
      }
    }
    // A bound store records where its ledger was on the computer that made
    // the backup. That path is only a hint (the ledger's identity binds), but
    // on this computer the ledger may sit under another name, so the hint is
    // pointed at where the restore puts it.
    const ledgers = plan
      .filter((entry) => entry.kind === 'judgments' && entry.to.endsWith(TIER_LEDGER_FILE_SUFFIX))
      .map((entry) => ({ sourceId: entry.sourceId, to: entry.to, id: TierLedger.readLedgerId(join(input, entry.from)) }));
    // The pictures go into this install's media cache before the stores that
    // point at them. The cache is content-addressed, so a picture this
    // computer already holds under its digest is the same bytes and stays.
    const pictures = new Map<string, string>();
    for (const entry of plan) {
      if (entry.kind !== 'media') continue;
      if (!existsSync(entry.to)) copyPrivate(join(input, entry.from), entry.to);
      pictures.set(entry.to.split('/').pop()!.slice(0, -'.jpg'.length), entry.to);
    }
    for (const entry of plan) {
      if (entry.kind === 'media') continue;
      if (entry.merge === 'mail_always_private') {
        const carried = JSON.parse(readFileSync(join(input, entry.from), 'utf8')) as { always_private_senders?: unknown };
        if (carryMailOwnerRules(entry.to, carried.always_private_senders) === 'kept_approval') {
          notes.push('Kept the mail scope this computer already approved; the backup\'s "always Private" senders were not added to it.');
        }
        continue;
      }
      if (entry.keptAs) copyPrivate(entry.to, entry.keptAs);
      let held: string[] = [];
      const prepare = entry.kind === 'store'
        ? (staged: string) => {
            repointLedgerHint(staged, (id) => ledgers.find((ledger) => ledger.sourceId === entry.sourceId && ledger.id === id)?.to);
            held = repointMediaPaths(staged, (sha256) => pictures.get(sha256));
          }
        : undefined;
      copyPrivate(join(input, entry.from), entry.to, prepare);
      // The restored store holds its pictures by its path until it is first
      // opened, which holds them again under its own name: until then the
      // cache's sweep sees a holder and keeps them.
      for (const sha256 of held) retainMediaCacheFile(pictures.get(sha256)!, sha256, entry.to);
    }
    for (const sourceId of writeRestoredIdentities(identities, bindingsPath, env)) {
      notes.push(`${sourceId}'s history came to name another account while restoring, so its account is asked again at sign-in.`);
    }
  }
  return {
    ok: true,
    input,
    dryRun: options.dryRun === true,
    exportVersion: manifest.version,
    sourceIds,
    restored: plan,
    signInAgain: sourceIds,
    notes,
  };
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

/**
 * The provider accounts a version 3 manifest records for the restored
 * sources. An older backup records none: its sources restore as before, and
 * their account is asked again at sign-in.
 */
function restoredAccountIdentities(manifest: ManifestShape, sourceIds: readonly string[]): RestoredAccountIdentity[] {
  if (manifest.version < 3 || !Array.isArray(manifest.accounts)) return [];
  const identities: RestoredAccountIdentity[] = [];
  for (const raw of manifest.accounts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const sourceId = record.source_id;
    if (typeof sourceId !== 'string' || !sourceIds.includes(sourceId) || record.slot !== DEFAULT_ACCOUNT_SLOT) continue;
    const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const historyAccount = text(record.provider_account_hash);
    const binding = record.account_binding && typeof record.account_binding === 'object' && !Array.isArray(record.account_binding)
      ? record.account_binding as Record<string, unknown>
      : undefined;
    const bound = accountBoundSourceIdForSource(sourceId);
    const boundAccount = bound ? text(binding?.provider_account_id) : undefined;
    const folders = bound && Array.isArray(binding?.previous_account_folders)
      ? binding.previous_account_folders.filter((id): id is string => typeof id === 'string')
      : [];
    if (!historyAccount && !boundAccount && folders.length === 0) continue;
    identities.push({
      sourceId,
      ...(historyAccount ? { historyAccount } : {}),
      ...(boundAccount ? { boundAccount } : {}),
      ...(folders.length > 0 ? { previousAccountFolders: folders } : {}),
    });
  }
  return identities;
}

function accountBoundSourceIdForSource(sourceId: string): AccountBoundSourceId | undefined {
  return (ACCOUNT_BOUND_SOURCE_IDS as readonly string[]).includes(sourceId) ? sourceId as AccountBoundSourceId : undefined;
}

/**
 * Refuses, before anything is written, a restore whose items came from another
 * account than the one this computer already records for the source: one
 * source never holds two accounts.
 */
function checkRestoredIdentities(identities: readonly RestoredAccountIdentity[], bindingsPath: string, env: Record<string, string | undefined>): void {
  if (identities.length === 0) return;
  const conflict = (sourceId: string): OperationError => new OperationError(
    'invalid_params',
    `This computer is already connected to another account for ${sourceId} than the one this backup's items came from, so nothing was restored.`,
    `Disconnect ${sourceId} and delete its data with olympus data delete --source ${sourceId}, then restore.`,
  );
  const read = readSourceAccountBindings(bindingsPath);
  if (identities.some((identity) => identity.boundAccount || identity.previousAccountFolders) && read.kind === 'malformed') {
    throw new SourceAccountBindingsUnreadableError(bindingsPath);
  }
  const registry = readSourceRegistry(env);
  for (const identity of identities) {
    const bound = accountBoundSourceIdForSource(identity.sourceId);
    const current = bound && read.kind === 'ok' ? read.bindings.sources[bound] : undefined;
    if (current?.purge_required) throw conflict(identity.sourceId);
    if (identity.boundAccount && current?.provider_account_id
      && compareProviderAccounts(current.provider_account_id, identity.boundAccount) !== 'same') throw conflict(identity.sourceId);
    const entry = findRegistryAccount(registry, identity.sourceId, DEFAULT_ACCOUNT_SLOT);
    if (entry && entry.state !== 'active') throw conflict(identity.sourceId);
    if (identity.historyAccount && entry?.provider_account_hash
      && compareProviderAccounts(entry.provider_account_hash, identity.historyAccount) !== 'same') throw conflict(identity.sourceId);
  }
}

/**
 * Write back which account the restored items came from: the source's binding
 * and its history's account. Returns the sources whose history another writer
 * named differently in between (checked before, so only a race): left as it is.
 */
function writeRestoredIdentities(identities: readonly RestoredAccountIdentity[], bindingsPath: string, env: Record<string, string | undefined>): string[] {
  const unrecorded: string[] = [];
  const now = new Date().toISOString();
  for (const identity of identities) {
    const bound = accountBoundSourceIdForSource(identity.sourceId);
    if (bound && (identity.boundAccount || identity.previousAccountFolders)) {
      updateSourceAccountBinding(bindingsPath, bound, (current) => ({
        ...current,
        ...(identity.boundAccount
          ? {
              provider_account_id: current?.provider_account_id
                ? mergeProviderAccountIds(current.provider_account_id, identity.boundAccount)
                : identity.boundAccount,
              bound_at: current?.bound_at ?? now,
            }
          : {}),
        ...(identity.previousAccountFolders
          ? { previous_account_folders: [...new Set([...(current?.previous_account_folders ?? []), ...identity.previousAccountFolders])].slice(0, 5) }
          : {}),
      }));
    }
    if (identity.historyAccount) {
      const recorded = recordProviderAccount({ sourceId: identity.sourceId, slot: DEFAULT_ACCOUNT_SLOT }, identity.historyAccount, env);
      if (recorded === 'different' || recorded === 'unproven') unrecorded.push(identity.sourceId);
    }
  }
  return unrecorded;
}

/** Copy owner-only and durably: a temporary file beside the target, then rename. */
function copyPrivate(from: string, to: string, prepare?: (staged: string) => void): void {
  // Every directory level the restore creates is flushed, as an export's are:
  // a file renamed into a directory whose own entry never reached the disk is
  // still gone after a power loss.
  makeDurableDirectory(dirname(to), exportDurabilityBoundary(dirname(to)));
  const staging = `${to}.${randomUUID()}.restoring`;
  try {
    copyFileSync(from, staging);
    chmodSync(staging, 0o600);
    prepare?.(staging);
    // The contents reach the disk before the name does.
    const descriptor = openSync(staging, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(staging, to);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
  syncDirectorySync(dirname(to));
}

function sovereigntyPath(homeDir: string | undefined, env: Record<string, string | undefined>): string {
  if (homeDir && process.platform !== 'linux') return join(homeDir, '.olympus', 'sovereignty.json');
  return defaultSovereigntyConfigPath(env);
}

function sourceSettingsTarget(artifact: DataExportArtifact, context: LifecyclePathContext): string {
  const name = artifact.relativePath.split('/').pop();
  const target = lifecycleAccountFiles(artifact.sourceId, context).settings.find((path) => path.split('/').pop() === name);
  if (!target) {
    throw new OperationError('invalid_params', `The backup holds a ${artifact.sourceId} settings file this version of Olympus does not keep: ${artifact.relativePath}.`);
  }
  return target;
}

/** Whether a store in the backup is bound to a tier ledger (it holds routed copies). */
function storeIsTierBound(path: string): boolean {
  const db = new Database(path, { readonly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000;');
    const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_runs'").get();
    if (!table) return false;
    const row = db.query('SELECT cursor FROM sync_runs WHERE sync_run_id = ? AND connector_id = ?').get(TIER_SET_BINDING_RUN_ID, TIER_SET_BINDING_CONNECTOR_ID) as { cursor: string | null } | null;
    return Boolean(row?.cursor);
  } finally {
    closeSqliteStore(db);
  }
}

/**
 * Point a restored store's chunks at their pictures in this install's media
 * cache. A chunk records the absolute path its picture had on the computer
 * that made the backup; every reader trusts only a cache file that exists, so
 * without this the pictures would be in the backup and never seen. A picture
 * the backup does not hold keeps its old path and embeds as text, as it would
 * have there. Returns the digests now pointed at this install's cache.
 */
function repointMediaPaths(storePath: string, pictureFor: (sha256: string) => string | undefined): string[] {
  const db = new Database(storePath, { readwrite: true, create: false });
  try {
    db.exec('PRAGMA busy_timeout = 10000;');
    const columns = (db.query('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((column) => column.name);
    if (!columns.includes('media_path') || !columns.includes('media_sha256')) return [];
    const releases = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_media_releases'").get());
    const digests = (db.query('SELECT DISTINCT media_sha256 FROM chunks WHERE media_sha256 IS NOT NULL AND media_path IS NOT NULL').all() as Array<{ media_sha256: string }>)
      .map((row) => row.media_sha256);
    const moved: string[] = [];
    db.transaction(() => {
      for (const sha256 of digests) {
        const path = pictureFor(sha256);
        if (!path) continue;
        db.query('UPDATE chunks SET media_path = ? WHERE media_sha256 = ? AND media_path IS NOT NULL').run(path, sha256);
        // A release queued on the old computer names the picture where it was there.
        if (releases) db.query('UPDATE chunk_media_releases SET media_path = ? WHERE media_sha256 = ?').run(path, sha256);
        moved.push(sha256);
      }
    })();
    return moved;
  } finally {
    closeSqliteStore(db);
  }
}

/** Point a bound store's ledger hint at where this computer keeps that ledger; the identity is unchanged. */
function repointLedgerHint(storePath: string, ledgerFor: (ledgerId: string) => string | undefined): void {
  if (!storeIsTierBound(storePath)) return;
  const db = new Database(storePath, { readwrite: true, create: false });
  try {
    db.exec('PRAGMA busy_timeout = 10000;');
    const row = db.query('SELECT cursor FROM sync_runs WHERE sync_run_id = ? AND connector_id = ?').get(TIER_SET_BINDING_RUN_ID, TIER_SET_BINDING_CONNECTOR_ID) as { cursor: string };
    const binding = JSON.parse(row.cursor) as { ledgerId?: unknown; ledgerPath?: unknown };
    if (typeof binding.ledgerId !== 'string') return;
    const ledgerPath = ledgerFor(binding.ledgerId);
    if (!ledgerPath || ledgerPath === binding.ledgerPath) return;
    db.query('UPDATE sync_runs SET cursor = ? WHERE sync_run_id = ? AND connector_id = ?')
      .run(JSON.stringify({ ...binding, ledgerPath }), TIER_SET_BINDING_RUN_ID, TIER_SET_BINDING_CONNECTOR_ID);
  } finally {
    closeSqliteStore(db);
  }
}
