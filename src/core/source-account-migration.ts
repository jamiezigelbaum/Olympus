/**
 * The boot migration: moves an existing account's files from where they have
 * always been into its account folder (docs/design/source-storage.md,
 * "Migration of existing installs"; delivery step 4c). Telegram and WhatsApp
 * are step 4d and are never touched here.
 *
 * It runs once per worker boot, under the owner lock, after
 * `replaceEmptyLegacyAccounts` and before adoption is enabled and anything
 * mounts, so no store is open anywhere while files move. It starts moves only
 * when `OLYMPUS_MIGRATE_ACCOUNT_FOLDERS=1` is in the worker's environment; a
 * move already under way (a plan in the registry) is finished or undone at
 * every boot, whatever the switch says, because its account stays closed until
 * one or the other.
 *
 * Per account, in this order:
 *
 * 1. Look at every file the account owns at its legacy locations. The account
 *    stays where it is, and the reason is recorded, when an override or mount
 *    pins it, a location cannot be looked at, a file is a link or the wrong
 *    kind, a destination already exists, a file is on another device than the
 *    folder, or the registry lists stores that are not there.
 * 2. `PRAGMA quick_check` each database, within a time budget, to record how it
 *    was. Never a reason to stop.
 * 3. Write the plan into the registry entry (`migration`, schema 3): each file,
 *    where it goes and its identity (dev, ino, size), and each store's
 *    media-cache holder names. From here the account is closed.
 * 4. Rename every file into the folder (a store with its `-wal`, `-shm` and
 *    tier sidecars). Nothing is copied.
 * 5. Verify: the same identity at every destination, then a read-only open of
 *    each database that opened before. A failure undoes the move.
 * 6. Point each store's tier-set binding (the one path a store keeps inside
 *    itself) at its ledger's new place.
 * 7. Re-key the media cache's holders to the stores' new paths.
 * 8. In one registry write: `layout: 'folder'` and the plan marked done.
 *
 * A crash anywhere resumes from the plan at the next boot. A failed check
 * renames everything back, leaves the account `legacy` and leaves a record the
 * dashboard turns into a Needs you row (`sourceStorageNotices`).
 *
 * Deliberately light, like the registry: no workers. The only database opens
 * are the checks and the binding rewrite in core/source-storage.ts.
 */
import { linkSync, lstatSync, mkdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { secretLocationsPathForStore, tierLedgerPathForStore, tierSnifferPathForStore } from '../workers/classification/tier-ledger-path.ts';
import { archiveImportFamilies } from './archive-formats.ts';
import { syncDirectorySync } from './atomic-file.ts';
import {
  MediaCacheRekeyStopped,
  addMediaCacheHolder,
  dropMediaCacheHolder,
  mediaCacheDir,
  mediaHolderDigests,
  nearRealPath,
} from './media-cache.ts';
import {
  accountFolder,
  accountFoldersRoot,
  accountRawPath,
  accountStorePath,
  legacyAccountFiles,
  migratableSources,
  olympusDataRoot,
  type AccountRawName,
  type LayoutAccount,
  type LayoutEnv,
} from './olympus-layout.ts';
import { legacyPinFor } from './source-placement.ts';
import { repointTierSetBinding, storeFileQuickCheck, storeFileReads } from './source-storage.ts';
import {
  DEFAULT_ACCOUNT_SLOT,
  findRegistryAccount,
  readSourceRegistry,
  sourceAccountMovePending,
  updateSourceRegistry,
  type SourceRegistryAccount,
  type SourceRegistryMediaHolder,
  type SourceRegistryMigration,
  type SourceRegistryMove,
} from './source-registry.ts';

/** The worker environment variable that lets a boot start moving accounts. Off unless it is exactly `1`. */
export const MIGRATE_ACCOUNT_FOLDERS_ENV = 'OLYMPUS_MIGRATE_ACCOUNT_FOLDERS';
// The bounds of one boot's pass (docs/design/source-storage.md, "Time"). Every
// operation that can take longer with more data is bounded by a size or a
// count, so the worst case is arithmetic, not hope: it is worked out there
// from these numbers and the slowest disk they assume.

/** The slowest disk the bounds assume (an old external drive), in bytes per second. */
export const ASSUMED_BYTES_PER_SECOND = 10 * 1024 * 1024;
/** Time a boot spends starting accounts (new moves and plans left part way); accounts left over go on at the next boot. */
export const MIGRATION_BUDGET_MS = 45_000;
/** Time a boot spends on `PRAGMA quick_check` across all accounts; a database that would not fit in what is left is recorded as not checked. */
export const QUICK_CHECK_BUDGET_MS = 15_000;
/** Largest database (its file, `-wal` and `-journal` together) `PRAGMA quick_check` is run on: it cannot be interrupted, so size is its only bound. */
export const QUICK_CHECK_STORE_MAX_BYTES = 64 * 1024 * 1024;
/** Most bytes `PRAGMA quick_check` reads in one boot, across all databases. */
export const QUICK_CHECK_TOTAL_MAX_BYTES = 128 * 1024 * 1024;
/** Most `-wal` and `-journal` bytes one account may carry into a move: opening a database reads its log once, and the pass opens each a handful of times. */
export const ACCOUNT_LOG_MAX_BYTES = 32 * 1024 * 1024;
/** After this long from the pass's start no more pictures are handed over; the plan stays and the next boot goes on. */
export const PASS_HARD_STOP_MS = 90_000;

/** Why an account stays where it is. Short codes; the registry holds them beside plain words. */
export type AccountMigrationSkipReason =
  | 'pinned'
  | 'unreadable'
  | 'unexpected_file'
  | 'destination_exists'
  | 'other_device'
  | 'files_elsewhere'
  | 'log_large';

/** Why a move was undone. */
export type AccountMigrationFailureReason = 'verify_failed' | 'move_failed';

const SKIP_REASONS: ReadonlySet<string> = new Set<AccountMigrationSkipReason>([
  'pinned',
  'unreadable',
  'unexpected_file',
  'destination_exists',
  'other_device',
  'files_elsewhere',
  'log_large',
]);

export interface AccountMigrationReport {
  /** Moved into their folders this boot. */
  moved: string[];
  /** Of those, the ones that finished a plan an earlier boot left. */
  resumed: string[];
  /** Moved, found wrong, and put back. */
  movedBack: Array<{ sourceId: string; reason: string }>;
  /** Left where they are, and why. */
  skipped: Array<{ sourceId: string; reason: string }>;
  /** Still part way, closed until a boot finishes them. */
  stuck: Array<{ sourceId: string; detail: string }>;
  /** Not started: the budget ran out. */
  deferred: string[];
  /** A failure that was not the account's (the registry changed under us, say). */
  errors: Array<{ sourceId: string; message: string }>;
}

/** Thrown by a test hook to stand for the process dying at that point; nothing in here catches it. */
export class AccountMigrationKilled extends Error {
  constructor(readonly at: string) {
    super(`killed at ${at}`);
    this.name = 'AccountMigrationKilled';
  }
}

/**
 * Test seams, all off in production. `checkpoint` is called between the steps
 * (`plan`, `rename:<n>`, `verified`, `rebound`, `rekeyed`, `flipped`, and on
 * the way back `revert`, `unrename:<n>`, `reverted`) and may throw
 * `AccountMigrationKilled`. `rename` replaces the rename, and `look` what the
 * pass sees at a path (a device that differs, a folder it may not search),
 * which a test cannot make a file system say.
 */
export const __accountMigrationTestHooks: {
  checkpoint?: (at: string) => void;
  rename?: (from: string, to: string, kind: 'file' | 'dir') => void;
  look?: (path: string, actual: MigrationLook) => MigrationLook | undefined;
  now?: () => number;
  budgetMs?: number;
  quickCheckBudgetMs?: number;
  /** Called right before a file is moved, after the checks: a place for a test to be "another process". */
  beforeMove?: (from: string, to: string) => void;
  /** Replaces `fsync` of a folder (the pass makes its renames durable through it). */
  syncDirectory?: (path: string) => void;
  /** Replaces the bounds above, one by one. */
  limits?: Partial<{
    quickCheckStoreMaxBytes: number;
    quickCheckTotalMaxBytes: number;
    accountLogMaxBytes: number;
    hardStopMs: number;
  }>;
  reset(): void;
} = {
  reset() {
    delete this.checkpoint;
    delete this.rename;
    delete this.look;
    delete this.now;
    delete this.budgetMs;
    delete this.quickCheckBudgetMs;
    delete this.beforeMove;
    delete this.syncDirectory;
    delete this.limits;
  },
};

export function accountFolderMigrationEnabled(env: LayoutEnv = process.env): boolean {
  return env[MIGRATE_ACCOUNT_FOLDERS_ENV]?.trim() === '1';
}

// ---------------------------------------------------------------------------
// What an account owns

const COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

interface Candidate {
  role: SourceRegistryMove['role'];
  from: string;
  to: string;
  kind: 'file' | 'dir';
  db: boolean;
}

const isCompanion = (path: string): boolean => COMPANION_SUFFIXES.some((suffix) => path.endsWith(suffix));

/**
 * Every file or folder an account of this source can own, at its default
 * legacy location and in its folder, whether or not it exists. The one list
 * both the plan and the check of a stored plan are made from.
 */
function candidates(sourceId: string, slot: string, env: LayoutEnv): Candidate[] {
  const account: LayoutAccount = { source_id: sourceId, slot, layout: 'folder' };
  const found: Candidate[] = [];
  const add = (role: Candidate['role'], from: string, to: string, kind: 'file' | 'dir', db: boolean): void => {
    found.push({ role, from, to, kind, db });
    if (db) for (const suffix of COMPANION_SUFFIXES) found.push({ role, from: `${from}${suffix}`, to: `${to}${suffix}`, kind: 'file', db: false });
  };
  for (const file of legacyAccountFiles(sourceId, env, archiveImportFamilies())) {
    if (file.area === 'store') {
      const to = accountStorePath(account, file.name, env);
      add('store', file.legacy, to, 'file', true);
      add('ledger', tierLedgerPathForStore(file.legacy), tierLedgerPathForStore(to), 'file', true);
      add('secrets', secretLocationsPathForStore(file.legacy), secretLocationsPathForStore(to), 'file', true);
      add('sniffer', tierSnifferPathForStore(file.legacy), tierSnifferPathForStore(to), 'file', true);
    } else {
      add('raw', file.legacy, accountRawPath(account, file.name as AccountRawName, env), file.rawKind === 'dir' ? 'dir' : 'file', file.rawKind === 'db');
    }
  }
  return found;
}

/** What `lstat` says about a path, in the terms the migration decides by. */
export type MigrationLook =
  | { kind: 'absent' | 'unreadable' | 'link' | 'other' }
  | { kind: 'file' | 'dir'; dev: bigint; ino: bigint; size: bigint };
type Look = MigrationLook;

function look(path: string): Look {
  const actual = lookAt(path);
  return __accountMigrationTestHooks.look?.(path, actual) ?? actual;
}

function lookAt(path: string): Look {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) return { kind: 'link' };
    if (stat.isDirectory()) return { kind: 'dir', dev: stat.dev, ino: stat.ino, size: stat.size };
    if (stat.isFile()) return { kind: 'file', dev: stat.dev, ino: stat.ino, size: stat.size };
    return { kind: 'other' };
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
}

// ---------------------------------------------------------------------------
// Context, paths and registry writes

interface Context {
  env: LayoutEnv;
  root: string;
  now: () => number;
  /** The media cache, or undefined when its location cannot be worked out (nothing can hold a file there). */
  cacheDir: string | undefined;
  quickCheckSpentMs: number;
  quickCheckBudgetMs: number;
  /** Bytes `PRAGMA quick_check` has read so far this boot. */
  quickCheckBytes: number;
  /** When the pass must stop handing pictures over (`PASS_HARD_STOP_MS` after it began). */
  hardStop: number;
}

/** Paths in the registry are relative to the data root and written with `/`, so the file never names a home folder. */
const relPath = (root: string, path: string): string => relative(root, path).split(sep).join('/');
const absPath = (root: string, rel: string): string => join(root, ...rel.split('/'));

const checkpoint = (at: string): void => __accountMigrationTestHooks.checkpoint?.(at);

const limit = (name: 'quickCheckStoreMaxBytes' | 'quickCheckTotalMaxBytes' | 'accountLogMaxBytes', fallback: number): number =>
  __accountMigrationTestHooks.limits?.[name] ?? fallback;

/** Errors that mean "this file system makes no hard links", not "this file cannot move". */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK']);

/**
 * Moves one file or folder to a place nothing else may already hold. A file is
 * linked to its new name (which fails with `EEXIST` if the name is taken, where
 * a rename would replace what is there) and then unlinked from the old one; a
 * kill between the two leaves one file under two names, which the next call
 * finishes (`moveOne`). Node has no portable no-replace rename for folders:
 * `rename(2)` of a folder fails onto a non-empty folder or any file, and
 * replaces only an EMPTY folder, which another process would have to have made
 * in the instant since the look. On a file system without hard links the file
 * is renamed after a last look, and that window is the whole protection.
 */
function moveWithoutReplacing(from: string, to: string, kind: 'file' | 'dir'): void {
  if (kind === 'dir') {
    renameSync(from, to);
    return;
  }
  try {
    linkSync(from, to);
  } catch (error) {
    if (!NO_HARD_LINKS.has(errorCode(error))) throw error;
    if (lookAt(to).kind !== 'absent') {
      throw Object.assign(new Error('The destination appeared.'), { code: 'EEXIST' });
    }
    renameSync(from, to);
    return;
  }
  unlinkSync(from);
}

const moveFile = (from: string, to: string, kind: 'file' | 'dir'): void =>
  (__accountMigrationTestHooks.rename ?? moveWithoutReplacing)(from, to, kind);

const syncFolder = (path: string): void => (__accountMigrationTestHooks.syncDirectory ?? syncDirectorySync)(path);

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? 'error';
}

/** Something that stops a move and says what to record. Carries no path. */
class MoveFault extends Error {
  constructor(
    readonly state: 'failed' | 'skipped',
    readonly reason: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'MoveFault';
  }
}

/** The entry changed (or went away) since the pass looked: leave it to whoever changed it. */
class EntryChanged extends Error {}

function updateAccount(
  ctx: Context,
  sourceId: string,
  slot: string,
  change: (account: SourceRegistryAccount) => void,
  options: { create?: boolean } = {},
): void {
  updateSourceRegistry(ctx.env, (registry) => {
    let account = findRegistryAccount(registry, sourceId, slot);
    if (!account && options.create) {
      account = {
        source_id: sourceId,
        slot,
        state: 'active',
        layout: 'legacy',
        corpus_ids: [],
        created_at: new Date(ctx.now()).toISOString(),
      };
      registry.accounts.push(account);
    }
    if (!account || account.state !== 'active') throw new EntryChanged();
    change(account);
  });
}

// ---------------------------------------------------------------------------
// Looking at an account

type Inspection =
  | { kind: 'nothing' }
  | { kind: 'skip'; reason: AccountMigrationSkipReason; detail: string }
  | { kind: 'move'; moves: SourceRegistryMove[]; holders: SourceRegistryMediaHolder[] };

const skip = (reason: AccountMigrationSkipReason, detail: string): Inspection => ({ kind: 'skip', reason, detail });

/**
 * The store name the layout gives a corpus id: its tier (`secure_local.email.private`
 * is `secure_local`), or for an imported archive `<family>.<tier>`
 * (`internal.archive.chat` is `chat.internal`). A name no store has (an archive
 * corpus of a shape this build does not write) is one the check cannot find.
 */
function storeNameForCorpus(sourceId: string, corpusId: string): string {
  const tier = corpusId.split('.')[0] ?? '';
  if (sourceId !== 'archive.imports') return tier;
  const family = /^[^.]+\.archive\.([^.]+)$/.exec(corpusId)?.[1];
  return family ? `${family}.${tier}` : corpusId;
}

/**
 * Whether every folder between the data root and a destination is a real
 * folder, or not there yet: none is a link that would take the file somewhere
 * else on the same device. The check Delete makes of an account folder (the
 * real path must be the lexical path under the data root's real path).
 */
function destinationIsOurs(ctx: Context, destination: string): boolean {
  const parent = dirname(destination);
  const below = relative(ctx.root, parent);
  if (below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) return false;
  return nearRealPath(parent) === join(nearRealPath(ctx.root), below);
}

function nearestExisting(path: string): string {
  let near = resolve(path);
  for (;;) {
    try {
      statSync(near);
      return near;
    } catch {
      const up = dirname(near);
      if (up === near) return near;
      near = up;
    }
  }
}

function inspect(ctx: Context, sourceId: string, slot: string, entry: SourceRegistryAccount | undefined): Inspection {
  const { env, root } = ctx;
  const pin = legacyPinFor(sourceId, env);
  if (pin) return skip('pinned', `${pin} names where its files are, so they stay there.`);
  const present: Array<{ candidate: Candidate; found: Extract<Look, { dev: bigint }> }> = [];
  for (const candidate of candidates(sourceId, slot, env)) {
    const found = look(candidate.from);
    if (found.kind === 'absent') continue;
    const name = basename(candidate.from);
    if (found.kind === 'unreadable') return skip('unreadable', `${name} cannot be looked at.`);
    if (found.kind === 'link' || found.kind === 'other' || found.kind !== candidate.kind) {
      return skip('unexpected_file', `${name} is not an ordinary ${candidate.kind === 'dir' ? 'folder' : 'file'}.`);
    }
    present.push({ candidate, found });
  }
  if (present.length === 0) {
    // Stores the registry lists that are nowhere to be seen may be where an
    // override once put them: moving nothing and calling the account a folder
    // would hide them.
    return entry && entry.corpus_ids.length > 0
      ? skip('files_elsewhere', 'Its stores are not at the usual place in the data folder.')
      : { kind: 'nothing' };
  }
  let folderDevice: bigint;
  try {
    folderDevice = statSync(nearestExisting(accountFolder({ source_id: sourceId, slot }, env)), { bigint: true }).dev;
  } catch {
    return skip('unreadable', 'The account folder cannot be looked at.');
  }
  for (const { candidate, found } of present) {
    const name = basename(candidate.from);
    if (!destinationIsOurs(ctx, candidate.to)) return skip('unexpected_file', `A folder on the way to ${name}'s place in the account folder is a link.`);
    const destination = look(candidate.to);
    if (destination.kind === 'unreadable') return skip('unreadable', `${name}'s place in the account folder cannot be looked at.`);
    if (destination.kind !== 'absent') return skip('destination_exists', `${name} is at its old place and in the account folder.`);
    if (found.dev !== folderDevice) return skip('other_device', `${name} is on a different device than the account folder.`);
  }
  // Opening a database reads its log once, and the pass opens each a handful of times, so the logs it carries are bounded.
  const logBytes = present
    .filter(({ candidate }) => candidate.from.endsWith('-wal') || candidate.from.endsWith('-journal'))
    .reduce((total, { found }) => total + Number(found.size), 0);
  if (logBytes > limit('accountLogMaxBytes', ACCOUNT_LOG_MAX_BYTES)) {
    return skip('log_large', 'Its write-ahead logs are large; they are folded into the stores the next time Olympus stops cleanly, and then it moves.');
  }
  if (entry) {
    const stores = new Set(present.filter(({ candidate }) => candidate.role === 'store' && candidate.db).map(({ candidate }) => candidate.to));
    const account: LayoutAccount = { source_id: sourceId, slot, layout: 'folder' };
    for (const corpusId of entry.corpus_ids) {
      let expected: string;
      try {
        expected = accountStorePath(account, storeNameForCorpus(sourceId, corpusId), env);
      } catch {
        continue; // A tier this source has no store for.
      }
      if (!stores.has(expected)) return skip('files_elsewhere', 'Its stores are not at the usual place in the data folder.');
    }
  }
  const moves = present.map(({ candidate, found }): SourceRegistryMove => ({
    role: candidate.role,
    from: relPath(root, candidate.from),
    to: relPath(root, candidate.to),
    kind: candidate.kind,
    ...(candidate.db ? { db: true as const } : {}),
    dev: String(found.dev),
    ino: String(found.ino),
    size: candidate.kind === 'dir' ? 0 : Number(found.size),
  }));
  const holders = present
    .filter(({ candidate }) => candidate.role === 'store' && candidate.db)
    .map(({ candidate }): SourceRegistryMediaHolder => ({ store: relPath(root, candidate.to), digests: mediaHolderDigests(candidate.from) }));
  return { kind: 'move', moves, holders };
}

/**
 * How each database was before the move, so a later failure is not blamed on
 * the move. Never stops anything. `PRAGMA quick_check` cannot be interrupted, so
 * whether one runs is decided BEFORE it starts, from what it would read (the
 * file, its `-wal` and its `-journal`) and what is left of the boot's bounds:
 * the size of one database, the bytes of all of them, and the time its reading
 * is assumed to take at the slowest disk the bounds allow for. A database that
 * does not fit is recorded `not_checked`.
 */
function checkDatabases(ctx: Context, moves: SourceRegistryMove[]): NonNullable<SourceRegistryMigration['checked']> {
  const storeMax = limit('quickCheckStoreMaxBytes', QUICK_CHECK_STORE_MAX_BYTES);
  const totalMax = limit('quickCheckTotalMaxBytes', QUICK_CHECK_TOTAL_MAX_BYTES);
  return moves.filter((move) => move.db).map((move) => {
    const path = absPath(ctx.root, move.from);
    if (!storeFileReads(path)) return { file: move.to, result: 'damaged' as const };
    const bytes = moves
      .filter((other) => other.from === move.from || other.from === `${move.from}-wal` || other.from === `${move.from}-journal`)
      .reduce((total, other) => total + other.size, 0);
    const estimateMs = (bytes / ASSUMED_BYTES_PER_SECOND) * 1000;
    if (bytes > storeMax || ctx.quickCheckBytes + bytes > totalMax || ctx.quickCheckSpentMs + estimateMs > ctx.quickCheckBudgetMs) {
      return { file: move.to, result: 'not_checked' as const };
    }
    const started = ctx.now();
    const result = storeFileQuickCheck(path);
    ctx.quickCheckSpentMs += ctx.now() - started;
    ctx.quickCheckBytes += bytes;
    return { file: move.to, result };
  });
}

// ---------------------------------------------------------------------------
// The move

/** The plan as the registry holds it must be one this code could have written: nothing else is ever renamed. */
function planIsCanonical(ctx: Context, sourceId: string, slot: string, migration: SourceRegistryMigration): boolean {
  let known: Candidate[];
  try {
    known = candidates(sourceId, slot, ctx.env);
  } catch {
    return false;
  }
  const pairs = new Set(known.map((candidate) => `${relPath(ctx.root, candidate.from)}\n${relPath(ctx.root, candidate.to)}`));
  const targets = new Set((migration.moves ?? []).map((move) => move.to));
  return (migration.moves ?? []).every((move) => pairs.has(`${move.from}\n${move.to}`) && !move.from.split('/').includes('..'))
    && (migration.holders ?? []).every((holder) => targets.has(holder.store));
}

/**
 * Makes the folders the files are going to, each made durable (the folder and
 * the folder that holds it are fsynced) before the next is made. Never through a
 * link: a component that is there must be a real folder.
 */
function makeFolders(ctx: Context, moves: SourceRegistryMove[]): void {
  try {
    const real = realpathSync(ctx.root);
    for (const move of moves) {
      const destination = dirname(absPath(ctx.root, move.to));
      if (!destinationIsOurs(ctx, absPath(ctx.root, move.to))) throw Object.assign(new Error('link'), { code: 'ELOOP' });
      let current = real;
      for (const part of relative(ctx.root, destination).split(sep).filter(Boolean)) {
        current = join(current, part);
        const found = lookAt(current);
        if (found.kind === 'dir') continue;
        if (found.kind !== 'absent') throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
        mkdirSync(current, { mode: 0o700 });
        syncFolder(dirname(current));
        syncFolder(current);
      }
    }
  } catch (error) {
    throw new MoveFault('failed', 'move_failed', `The account folder could not be made (${errorCode(error)}).`);
  }
}

/**
 * Makes the renames durable: the folder each file left and the folder it went
 * to are fsynced. Called after the last rename and before the registry records
 * anything that depends on them, so the record can never outlive the move it
 * describes.
 */
function syncMoveFolders(ctx: Context, moves: SourceRegistryMove[]): void {
  const folders = new Set<string>();
  for (const move of moves) {
    folders.add(dirname(absPath(ctx.root, move.from)));
    folders.add(dirname(absPath(ctx.root, move.to)));
  }
  try {
    for (const folder of folders) {
      if (lookAt(folder).kind === 'dir') syncFolder(folder);
    }
  } catch (error) {
    throw new MoveFault('failed', 'move_failed', `The move could not be made durable (${errorCode(error)}).`);
  }
}

/** Removes the folders a move made and undid, `sources/` itself included, deepest first; one that holds anything stays. */
function removeEmptyFolders(ctx: Context, moves: SourceRegistryMove[]): void {
  const stop = accountFoldersRoot(ctx.env);
  const folders = new Set<string>();
  for (const move of moves) {
    for (let folder = dirname(absPath(ctx.root, move.to)); folder === stop || folder.startsWith(`${stop}${sep}`); folder = dirname(folder)) {
      folders.add(folder);
      if (folder === stop) break;
    }
  }
  for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(folder);
    } catch {
      // Not empty, or already gone.
    }
  }
}

/**
 * What a file with no content to lose may be missing: SQLite's `-shm` (rebuilt
 * on the next open), and a `-wal` or `-journal` that held nothing when the plan
 * was made. A `-wal` or `-journal` that held bytes is committed data that is not
 * in the database file yet, and its loss is a loss.
 */
const isDisposable = (move: Pick<SourceRegistryMove, 'from' | 'size'>): boolean =>
  move.from.endsWith('-shm') || ((move.from.endsWith('-wal') || move.from.endsWith('-journal')) && move.size === 0);

/** That what is at a path is the very file or folder the plan recorded, not one that is merely called the same. */
const isPlanned = (found: Look, move: SourceRegistryMove): boolean =>
  (found.kind === 'file' || found.kind === 'dir') && found.kind === move.kind && String(found.dev) === move.dev && String(found.ino) === move.ino;

/**
 * Moves one planned file or folder, never onto something that is there. Returns
 * `moved`, `there` (an earlier run already did) or `lost` (it is in neither
 * place, and is not a file that may be missing). The caller decides what a
 * loss means: going forward the move stops, going back the account stays closed.
 */
function moveOne(ctx: Context, move: SourceRegistryMove, direction: 'forward' | 'back'): 'moved' | 'there' | 'lost' {
  const [from, to] = direction === 'forward'
    ? [absPath(ctx.root, move.from), absPath(ctx.root, move.to)]
    : [absPath(ctx.root, move.to), absPath(ctx.root, move.from)];
  const source = look(from);
  const target = look(to);
  const name = basename(move.from);
  if (source.kind === 'absent') {
    if (target.kind !== 'absent') return 'there'; // An earlier boot got this far.
    return isDisposable(move) ? 'there' : 'lost';
  }
  if (target.kind !== 'absent') {
    // Going back: the folder holds something that is not the planned file (another process put it there, which is why the move
    // forward stopped), and the planned file is already at its old place. There is nothing to move, and what is not ours stays.
    if (direction === 'back' && move.ino !== '' && !isPlanned(source, move) && isPlanned(target, move)) return 'there';
    // One file under two names is how a move that was killed between its link and its unlink looks; it is finished by the unlink.
    if (
      move.kind === 'file' && source.kind === 'file' && target.kind === 'file'
      && source.dev === target.dev && source.ino === target.ino && String(source.ino) === move.ino
    ) {
      try {
        unlinkSync(from);
      } catch (error) {
        throw new MoveFault('failed', 'move_failed', `${name} could not be moved (${errorCode(error)}).`);
      }
      return 'moved';
    }
    throw new MoveFault('failed', 'move_failed', `${name} is in both places.`);
  }
  // Checked again for this file, now: a folder on the way may have become a link since the plan.
  if (!destinationIsOurs(ctx, to) || !destinationIsOurs(ctx, from)) {
    throw new MoveFault('failed', 'move_failed', `A folder on the way to ${name} is a link.`);
  }
  try {
    __accountMigrationTestHooks.beforeMove?.(from, to);
    moveFile(from, to, move.kind);
  } catch (error) {
    if (error instanceof AccountMigrationKilled) throw error;
    const code = errorCode(error);
    if (code === 'EXDEV') {
      throw new MoveFault('skipped', 'other_device', `${name} is on a different device than the account folder.`);
    }
    if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR') {
      throw new MoveFault('failed', 'move_failed', `${name} is in both places.`);
    }
    throw new MoveFault('failed', 'move_failed', `${name} could not be renamed (${code}).`);
  }
  return 'moved';
}

/** The same dev, ino and size at the destination as the plan recorded at the old place. */
function verifyIdentity(ctx: Context, moves: SourceRegistryMove[]): void {
  for (const move of moves) {
    const found = look(absPath(ctx.root, move.to));
    if (found.kind === 'absent' && isDisposable(move)) continue;
    if ((found.kind !== 'file' && found.kind !== 'dir') || found.kind !== move.kind) {
      throw new MoveFault('failed', 'verify_failed', `${basename(move.from)} is not there after the move.`);
    }
    if (String(found.dev) !== move.dev || String(found.ino) !== move.ino) {
      throw new MoveFault('failed', 'verify_failed', `${basename(move.from)} is not the same file after the move.`);
    }
    if (move.kind === 'file' && !move.from.endsWith('-shm') && Number(found.size) !== move.size) {
      throw new MoveFault('failed', 'verify_failed', `${basename(move.from)} changed size in the move (${move.size} bytes, now ${Number(found.size)}).`);
    }
  }
}

/**
 * That a move put back is complete: every planned file is at its old place
 * (a file found again there counts, whoever restored it), and none of the
 * planned files is left in the folder. Something else that sits at a
 * destination is not ours and is not a reason to keep the account closed. A
 * plan is cleared only after this.
 */
function verifyRestored(ctx: Context, moves: SourceRegistryMove[]): void {
  for (const move of moves) {
    const back = look(absPath(ctx.root, move.from));
    if (isPlanned(look(absPath(ctx.root, move.to)), move)) {
      throw new MoveFault('failed', 'move_failed', `${basename(move.from)} is still in the account folder.`);
    }
    if (back.kind === 'absent' && isDisposable(move)) continue;
    if ((back.kind !== 'file' && back.kind !== 'dir') || back.kind !== move.kind) {
      throw new MoveFault('failed', 'move_failed', `${basename(move.from)} is not back at its old place.`);
    }
  }
}

function stateBefore(migration: SourceRegistryMigration, move: SourceRegistryMove): 'ok' | 'damaged' | 'not_checked' | undefined {
  return migration.checked?.find((checked) => checked.file === move.to)?.result;
}

/** The set ledger a store's binding names, mapped between the two places. */
function ledgerMap(ctx: Context, moves: SourceRegistryMove[], direction: 'forward' | 'back'): (ledgerPath: string) => string | undefined {
  const ledgers = moves.filter((move) => move.role === 'ledger' && move.db === true).map((move) => ({
    from: absPath(ctx.root, move.from),
    to: absPath(ctx.root, move.to),
  }));
  return (ledgerPath) => {
    const named = nearRealPath(ledgerPath);
    const found = ledgers.find((ledger) => nearRealPath(ledger.from) === named || nearRealPath(ledger.to) === named);
    return found ? (direction === 'forward' ? found.to : found.from) : undefined;
  };
}

function rebindStores(ctx: Context, migration: SourceRegistryMigration, moves: SourceRegistryMove[], direction: 'forward' | 'back'): void {
  const map = ledgerMap(ctx, moves, direction);
  for (const move of moves) {
    if (move.role !== 'store' || move.db !== true || isCompanion(move.from)) continue;
    const path = absPath(ctx.root, direction === 'forward' ? move.to : move.from);
    try {
      repointTierSetBinding(path, map);
    } catch (error) {
      // A store that did not open before is no worse for the move, and one that does not open now has no
      // link to put back (the files return to their places all the same).
      if (stateBefore(migration, move) === 'damaged' || (direction === 'back' && !storeFileReads(path))) continue;
      throw new MoveFault('failed', 'verify_failed', `${basename(move.from)}'s link to its tier ledger could not be updated (${errorCode(error)}).`);
    }
  }
}

/**
 * The media cache keeps a picture while some store holds it, and names the
 * holder by the store's path, so a store that moves must be handed over. In two
 * halves, either side of the renames. BEFORE them (`holdPictures`) a durable
 * marker under the destination's name is added for every picture, the old one
 * kept: the store still sits at its old place, so nothing is lost if this is cut
 * short (`MediaCacheRekeyStopped`, when the pass is out of time, ends the pass
 * with the plan kept; no file has moved), and from the moment the renames are
 * done every picture is held by the store where it now is. AFTER them
 * (`releasePictures`) the old markers go, which needs no care: one that comes
 * back names a store that is gone, and the sweep removes it.
 */
function holdersAt(ctx: Context, migration: SourceRegistryMigration, direction: 'forward' | 'back'): Array<{ from: readonly string[]; to: string }> {
  const places: Array<{ from: readonly string[]; to: string }> = [];
  for (const holder of migration.holders ?? []) {
    const move = (migration.moves ?? []).find((candidate) => candidate.to === holder.store);
    if (!move) continue;
    const store = absPath(ctx.root, holder.store);
    places.push(direction === 'forward'
      ? { from: holder.digests, to: store }
      : { from: mediaHolderDigests(store), to: absPath(ctx.root, move.from) });
  }
  return places;
}

function holdPictures(ctx: Context, migration: SourceRegistryMigration, direction: 'forward' | 'back'): void {
  if (!ctx.cacheDir) return;
  const stop = (): boolean => ctx.now() >= ctx.hardStop;
  for (const place of holdersAt(ctx, migration, direction)) addMediaCacheHolder(ctx.cacheDir, place.from, place.to, { stop });
}

function releasePictures(ctx: Context, migration: SourceRegistryMigration, direction: 'forward' | 'back'): void {
  if (!ctx.cacheDir) return;
  const stop = (): boolean => ctx.now() >= ctx.hardStop;
  for (const place of holdersAt(ctx, migration, direction)) dropMediaCacheHolder(ctx.cacheDir, place.from, place.to, { stop });
}

function forward(ctx: Context, sourceId: string, slot: string, migration: SourceRegistryMigration): void {
  const moves = migration.moves ?? [];
  // Before anything moves: every picture gets a holder under the name its store will have.
  holdPictures(ctx, migration, 'forward');
  checkpoint('held');
  makeFolders(ctx, moves);
  moves.forEach((move, index) => {
    if (moveOne(ctx, move, 'forward') === 'lost') {
      throw new MoveFault('failed', 'move_failed', `${basename(move.from)} is in neither place.`);
    }
    checkpoint(`rename:${index}`);
  });
  // The renames are on disk before the registry says anything that depends on them.
  syncMoveFolders(ctx, moves);
  if (migration.verified !== true) {
    verifyIdentity(ctx, moves);
    for (const move of moves) {
      if (move.db !== true || isCompanion(move.from) || stateBefore(migration, move) === 'damaged') continue;
      if (!storeFileReads(absPath(ctx.root, move.to))) {
        throw new MoveFault('failed', 'verify_failed', `${basename(move.from)} does not open after the move.`);
      }
    }
    // Later steps change file sizes, so a resume must not check them again.
    updateAccount(ctx, sourceId, slot, (account) => {
      if (account.migration?.state !== 'moving') throw new EntryChanged();
      account.migration.verified = true;
    });
    migration = { ...migration, verified: true };
  }
  checkpoint('verified');
  rebindStores(ctx, migration, moves, 'forward');
  checkpoint('rebound');
  releasePictures(ctx, migration, 'forward');
  checkpoint('rekeyed');
  // The layout and the plan's end are one write: there is no moment at which an
  // account is a folder with its plan still pending, or done and legacy.
  updateAccount(ctx, sourceId, slot, (account) => {
    if (account.migration?.state !== 'moving') throw new EntryChanged();
    account.layout = 'folder';
    account.migration = {
      state: 'done',
      at: new Date(ctx.now()).toISOString(),
      ...(migration.checked ? { checked: migration.checked } : {}),
    };
  });
  checkpoint('flipped');
}

/** Puts every file back, then records why. A pending `reverting` record is what a crash in here resumes from. */
function revert(ctx: Context, sourceId: string, slot: string, migration: SourceRegistryMigration, fault: MoveFault): void {
  const moves = migration.moves ?? [];
  if (migration.state !== 'reverting') {
    updateAccount(ctx, sourceId, slot, (account) => {
      if (!account.migration || !sourceAccountMovePending(account)) throw new EntryChanged();
      account.migration = { ...account.migration, state: 'reverting', reason: fault.reason, detail: fault.detail };
    });
  }
  checkpoint('revert');
  // Before anything moves back: every picture gets a holder under the name its store is about to have again.
  holdPictures(ctx, migration, 'back');
  const back = [...moves].reverse();
  // Everything that can go back does, and a file that is in neither place is named at the end: the account stays closed with its plan.
  const lost: string[] = [];
  back.forEach((move, index) => {
    if (moveOne(ctx, move, 'back') === 'lost') lost.push(basename(move.from));
    checkpoint(`unrename:${index}`);
  });
  // A database opened after its move may have made its own `-wal` or `-shm` there; they go back with it.
  for (const move of moves) {
    if (move.db !== true) continue;
    for (const suffix of COMPANION_SUFFIXES) {
      const extra = { ...move, from: `${move.from}${suffix}`, to: `${move.to}${suffix}`, kind: 'file' as const, size: 0, ino: '' };
      if (!moves.some((planned) => planned.to === extra.to)) moveOne(ctx, extra, 'back');
    }
  }
  if (lost.length > 0) {
    throw new MoveFault('failed', 'move_failed', `${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} in neither place, so the account stays closed until found.`);
  }
  // The plan is cleared only when everything is where it was.
  verifyRestored(ctx, moves);
  rebindStores(ctx, migration, moves, 'back');
  releasePictures(ctx, migration, 'back');
  removeEmptyFolders(ctx, moves);
  syncMoveFolders(ctx, moves);
  updateAccount(ctx, sourceId, slot, (account) => {
    if (account.migration?.state !== 'reverting') throw new EntryChanged();
    // An entry the pass left `legacy` is `legacy` again: a re-placement that ran in between must not leave it a folder with nothing in it.
    account.layout = 'legacy';
    account.migration = {
      state: SKIP_REASONS.has(fault.reason) ? 'skipped' : 'failed',
      at: new Date(ctx.now()).toISOString(),
      reason: fault.reason,
      detail: fault.detail,
      ...(migration.checked ? { checked: migration.checked } : {}),
    };
  });
  checkpoint('reverted');
}

// ---------------------------------------------------------------------------
// The pass

type Outcome =
  | { kind: 'moved' }
  | { kind: 'movedBack'; reason: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'stuck'; detail: string }
  | { kind: 'nothing' };

/** Nothing the plan names is in either place: the account's files were deleted while the move was part way. */
function planIsMoot(ctx: Context, migration: SourceRegistryMigration): boolean {
  const moves = migration.moves ?? [];
  return moves.length > 0 && moves.every((move) => look(absPath(ctx.root, move.from)).kind === 'absent' && look(absPath(ctx.root, move.to)).kind === 'absent');
}

const MORE_TIME_DETAIL = 'Handing its pictures to their new place takes more than one start; the next start goes on from where this one stopped.';

/** Finishes or undoes a plan the registry holds. */
function runPlan(ctx: Context, account: SourceRegistryAccount): Outcome {
  const migration = account.migration!;
  const { source_id: sourceId, slot } = account;
  if (!migratableSources().includes(sourceId) || !planIsCanonical(ctx, sourceId, slot, migration)) {
    return { kind: 'stuck', detail: 'Its move plan is not one this build wrote, so nothing was touched.' };
  }
  if (planIsMoot(ctx, migration)) {
    updateAccount(ctx, sourceId, slot, (entry) => {
      if (!entry.migration || !sourceAccountMovePending(entry)) throw new EntryChanged();
      delete entry.migration;
    });
    return { kind: 'nothing' };
  }
  try {
    if (migration.state === 'reverting') {
      const reason = migration.reason ?? 'verify_failed';
      throw new MoveFault(SKIP_REASONS.has(reason) ? 'skipped' : 'failed', reason, migration.detail ?? 'A move was undone.');
    }
    forward(ctx, sourceId, slot, migration);
    return { kind: 'moved' };
  } catch (error) {
    if (error instanceof AccountMigrationKilled || error instanceof EntryChanged) throw error;
    // Out of time for handing pictures over: nothing is wrong, the plan stays and the next boot goes on.
    if (error instanceof MediaCacheRekeyStopped) return { kind: 'stuck', detail: MORE_TIME_DETAIL };
    const fault = error instanceof MoveFault
      ? error
      : new MoveFault('failed', 'move_failed', `The move stopped unexpectedly (${errorCode(error)}).`);
    try {
      revert(ctx, sourceId, slot, migration, fault);
    } catch (revertError) {
      if (revertError instanceof AccountMigrationKilled || revertError instanceof EntryChanged) throw revertError;
      if (revertError instanceof MediaCacheRekeyStopped) return { kind: 'stuck', detail: MORE_TIME_DETAIL };
      const detail = revertError instanceof MoveFault ? revertError.detail : `Putting its files back stopped (${errorCode(revertError)}).`;
      return { kind: 'stuck', detail };
    }
    return fault.state === 'skipped' ? { kind: 'skipped', reason: fault.reason } : { kind: 'movedBack', reason: fault.reason };
  }
}

/** Records, only when it differs from what is there, that an account stays where it is. */
function recordSkip(ctx: Context, sourceId: string, slot: string, entry: SourceRegistryAccount | undefined, inspection: Extract<Inspection, { kind: 'skip' }>): void {
  const before = entry?.migration;
  if (before?.state === 'skipped' && before.reason === inspection.reason && before.detail === inspection.detail) return;
  // An account with no entry gets one only for a reason the owner can act on:
  // the others are logged, and the account is recorded when its first store opens.
  if (!entry && inspection.reason !== 'unreadable' && inspection.reason !== 'destination_exists') return;
  updateAccount(ctx, sourceId, slot, (account) => {
    if (account.layout !== 'legacy' || sourceAccountMovePending(account)) throw new EntryChanged();
    account.migration = {
      state: 'skipped',
      at: new Date(ctx.now()).toISOString(),
      reason: inspection.reason,
      detail: inspection.detail,
    };
  }, { create: true });
}

function startMove(ctx: Context, sourceId: string, slot: string, entry: SourceRegistryAccount | undefined): Outcome {
  let inspection = inspect(ctx, sourceId, slot, entry);
  if (inspection.kind === 'move') {
    // Reading a database can make its `-shm`, so look again afterwards: the plan names what is there.
    const checked = checkDatabases(ctx, inspection.moves);
    inspection = inspect(ctx, sourceId, slot, entry);
    if (inspection.kind === 'move') {
      const { moves, holders } = inspection;
      updateAccount(ctx, sourceId, slot, (account) => {
        if (account.layout !== 'legacy' || sourceAccountMovePending(account)) throw new EntryChanged();
        account.migration = { state: 'moving', at: new Date(ctx.now()).toISOString(), moves, holders, ...(checked.length > 0 ? { checked } : {}) };
      }, { create: true });
      checkpoint('plan');
      return runPlan(ctx, readSourceRegistryAccount(ctx, sourceId, slot));
    }
  }
  if (inspection.kind === 'skip') {
    recordSkip(ctx, sourceId, slot, entry, inspection);
    return { kind: 'skipped', reason: inspection.reason };
  }
  return { kind: 'nothing' };
}

function readSourceRegistryAccount(ctx: Context, sourceId: string, slot: string): SourceRegistryAccount {
  const account = findRegistryAccount(readSourceRegistry(ctx.env), sourceId, slot);
  if (!account) throw new EntryChanged();
  return account;
}

function context(env: LayoutEnv): Context | undefined {
  let root: string;
  try {
    root = olympusDataRoot(env);
  } catch {
    return undefined; // The data folder cannot be worked out here.
  }
  if (!isAbsolute(root)) return undefined;
  let cacheDir: string | undefined;
  try {
    cacheDir = mediaCacheDir(env);
  } catch {
    cacheDir = undefined;
  }
  const now = __accountMigrationTestHooks.now ?? Date.now;
  return {
    env,
    root,
    now,
    cacheDir,
    quickCheckSpentMs: 0,
    quickCheckBudgetMs: __accountMigrationTestHooks.quickCheckBudgetMs ?? QUICK_CHECK_BUDGET_MS,
    quickCheckBytes: 0,
    hardStop: now() + (__accountMigrationTestHooks.limits?.hardStopMs ?? PASS_HARD_STOP_MS),
  };
}

/**
 * Worker boot, under the owner lock, before anything mounts. Finishes or undoes
 * any plan the registry holds, then (with the switch on) starts moving each
 * legacy account of a migratable source until the budget runs out. Throws what
 * the registry throws when it cannot be read: then nothing is known about any
 * account, and the caller carries on as it always did.
 */
export function migrateAccountFolders(env: LayoutEnv = process.env): AccountMigrationReport {
  const report: AccountMigrationReport = { moved: [], resumed: [], movedBack: [], skipped: [], stuck: [], deferred: [], errors: [] };
  const registry = readSourceRegistry(env);
  const ctx = context(env);
  if (!ctx) return report;
  const run = (sourceId: string, work: () => Outcome, resumed = false): void => {
    try {
      const outcome = work();
      if (outcome.kind === 'moved') {
        report.moved.push(sourceId);
        if (resumed) report.resumed.push(sourceId);
      } else if (outcome.kind === 'movedBack') report.movedBack.push({ sourceId, reason: outcome.reason });
      else if (outcome.kind === 'skipped') report.skipped.push({ sourceId, reason: outcome.reason });
      else if (outcome.kind === 'stuck') report.stuck.push({ sourceId, detail: outcome.detail });
    } catch (error) {
      if (error instanceof AccountMigrationKilled) throw error;
      report.errors.push({ sourceId, message: error instanceof EntryChanged ? 'its registry entry changed' : errorCode(error) });
    }
  };
  // A plan that is part way comes first, switch or no: its account is closed until it is done.
  // One that ended in a move back is not started again in this boot.
  const handled = new Set<string>();
  // One deadline for starting any account, a plan left part way included: what one account can cost after it
  // starts is bounded (see the constants above), so the pass ends within the deadline plus that.
  const deadline = ctx.now() + (__accountMigrationTestHooks.budgetMs ?? MIGRATION_BUDGET_MS);
  for (const account of registry.accounts.filter(sourceAccountMovePending)) {
    handled.add(account.source_id);
    if (ctx.now() >= deadline) {
      report.deferred.push(account.source_id);
      continue;
    }
    run(account.source_id, () => runPlan(ctx, account), true);
  }
  if (!accountFolderMigrationEnabled(env)) return report;
  for (const sourceId of migratableSources()) {
    if (handled.has(sourceId)) continue;
    const entry = findRegistryAccount(readSourceRegistry(env), sourceId, DEFAULT_ACCOUNT_SLOT);
    if (entry && (entry.state !== 'active' || entry.layout !== 'legacy' || sourceAccountMovePending(entry))) continue;
    if (ctx.now() >= deadline) {
      report.deferred.push(sourceId);
      continue;
    }
    run(sourceId, () => startMove(ctx, sourceId, DEFAULT_ACCOUNT_SLOT, entry));
  }
  return report;
}
