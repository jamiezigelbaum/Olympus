/**
 * The boot migration: moves an existing account's files from where they have
 * always been into its account folder (docs/design/source-storage.md,
 * "Migration of existing installs"; delivery steps 4c and 4d). Telegram's and
 * WhatsApp's accounts (4d) move the same way, with three more things: their
 * old places are outside the data folder (the capture and state roots, named
 * in the plan by a tag), a capture helper that is running keeps its account
 * where it is (its lock is held through the pass), and their records outside
 * the data folder (capture grant, stored session paths) are weighed before and
 * rewritten after the move (core/messaging-account-move.ts).
 *
 * It runs once per worker boot, under the owner lock, after
 * `replaceEmptyLegacyAccounts` and before adoption is enabled and anything
 * mounts, so no store is open anywhere while files move. It starts moves only
 * when `OLYMPUS_MIGRATE_ACCOUNT_FOLDERS=1` is in the worker's environment; a
 * move already under way (a plan in the registry) is finished or undone at
 * every boot, whatever the switch says, because its account stays closed until
 * one or the other.
 *
 * The move only renames files. Nothing in a store, a ledger or the media cache
 * names a path any more (a store finds its set ledger by the ledger's id; a
 * picture hold names the account and the store), so nothing there is rewritten.
 * The one write to a database before the move is SQLite's own checkpoint.
 *
 * Per account, in this order:
 *
 * 1. Look at every file the account owns at its legacy locations. The account
 *    stays where it is, and the reason is recorded, when an override or mount
 *    pins it, a location cannot be looked at, a file is a link or the wrong
 *    kind, a destination already exists, a file is on another device than the
 *    folder, the registry lists stores that are not there, or its logs are
 *    large.
 * 2. Fold each database's write-ahead log into the database
 *    (`PRAGMA wal_checkpoint(TRUNCATE)`): afterwards the database file is the
 *    whole database, whatever happens to a `-wal` in the move. The account stays
 *    where it is when a log cannot be folded completely.
 * 3. `PRAGMA quick_check` each database, within a time budget, to record how it
 *    was. Never a reason to stop.
 * 4. Write the plan into the registry entry (`migration`, schema 3): each file,
 *    where it goes and its identity (dev, ino, size). From here the account is
 *    closed.
 * 5. Move every file into the folder (a store with its `-shm` and tier
 *    sidecars): a hard link to the new name, the new folder made durable, and
 *    only then the old name removed, so a file another process put at the
 *    destination is never replaced and a power failure never finds a file
 *    with no durable name. Nothing is copied. A file system that makes no hard
 *    links keeps the account where it is.
 * 6. Verify: the same identity at every destination, then an open of each
 *    database that opened before (it writes nothing). A failure undoes the move.
 * 7. In one registry write: `layout: 'folder'` and the plan marked done.
 *
 * A crash anywhere resumes from the plan at the next boot. A failed check
 * moves everything back, leaves the account `legacy` and leaves a record the
 * dashboard turns into a Needs you row (`sourceStorageNotices`).
 *
 * Every database open and checkpoint waits for another connection at most
 * 2 s, and no longer than what is left of the boot's deadline. A database
 * another connection has locked is not worked around: the account stays where
 * it is this boot (`busy`).
 *
 * Deliberately light, like the registry: no workers. The only database opens
 * are the fold and the checks in core/source-storage.ts.
 */
import { linkSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { secretLocationsPathForStore, tierLedgerPathForStore, tierSnifferPathForStore } from '../workers/classification/tier-ledger-path.ts';
import { archiveImportFamilies } from './archive-formats.ts';
import { syncDirectorySync } from './atomic-file.ts';
import { tryHoldFileFlock, type HeldFileFlock } from './data-owner-lock.ts';
import {
  TELEGRAM_SOURCE_ID,
  WHATSAPP_SOURCE_ID,
  accountFolder,
  accountFoldersRoot,
  accountRawPath,
  accountStorePath,
  folderNameOfStagedTelegramLogin,
  legacyAccountFiles,
  legacyTelegramSessionBase,
  legacyWhatsAppDefaultStateDir,
  legacyWhatsAppLiveSyncStateDir,
  legacyWhatsAppServiceStateDir,
  migratableSources,
  migrationPathRoots,
  olympusDataRoot,
  type AccountRawName,
  type LayoutAccount,
  type LayoutEnv,
} from './olympus-layout.ts';
import { legacyPinFor } from './source-placement.ts';
import { storeFileCheckpoint, storeFileQuickCheck, storeFileReads } from './source-storage.ts';
import {
  DEFAULT_ACCOUNT_SLOT,
  findRegistryAccount,
  readSourceRegistry,
  sourceAccountMovePending,
  updateSourceRegistry,
  type SourceRegistryAccount,
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
/** Most `-wal` and `-journal` bytes one account may have when the pass looks at it: folding them into the databases reads them once, and opening a database reads its log. */
export const ACCOUNT_LOG_MAX_BYTES = 32 * 1024 * 1024;
/**
 * The longest one wait for another connection may be, in milliseconds, for a
 * checkpoint or an open alike, and never longer than what is left of the boot's
 * deadline (`waitMs`). The first database that is busy ends its account's
 * pass, so an account waits once.
 */
export const LOCK_WAIT_CAP_MS = 2_000;

/** Why an account stays where it is. Short codes; the registry holds them beside plain words. */
export type AccountMigrationSkipReason =
  | 'pinned'
  | 'unreadable'
  | 'unexpected_file'
  | 'destination_exists'
  | 'other_device'
  | 'files_elsewhere'
  | 'log_large'
  | 'log_not_folded'
  | 'busy'
  | 'no_hard_links';

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
  'log_not_folded',
  'busy',
  'no_hard_links',
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
 * (`folded`, `plan`, `rename:<n>`, `verified`, `flipped`, and on the way back
 * `revert`, `unrename:<n>`, `reverted`) and may throw `AccountMigrationKilled`.
 * `rename` replaces the move of a file, `link` the hard link it starts with, and
 * `look` what the pass sees at a path (a device that differs, a folder it may
 * not search), which a test cannot make a file system say.
 */
export const __accountMigrationTestHooks: {
  checkpoint?: (at: string) => void;
  rename?: (from: string, to: string, kind: 'file' | 'dir') => void;
  link?: (from: string, to: string) => void;
  look?: (path: string, actual: MigrationLook) => MigrationLook | undefined;
  now?: () => number;
  budgetMs?: number;
  quickCheckBudgetMs?: number;
  /** Called right before a file is moved, after the checks: a place for a test to be "another process". */
  beforeMove?: (from: string, to: string) => void;
  /** Replaces `fsync` of a folder (the pass makes its renames durable through it). */
  syncDirectory?: (path: string) => void;
  /** Replaces the take of a capture helper's lock (`tryHoldFileFlock`). */
  captureLock?: (path: string) => HeldFileFlock | undefined;
  /** Replaces the bounds above, one by one. */
  limits?: Partial<{
    quickCheckStoreMaxBytes: number;
    quickCheckTotalMaxBytes: number;
    accountLogMaxBytes: number;
  }>;
  reset(): void;
} = {
  reset() {
    delete this.checkpoint;
    delete this.rename;
    delete this.link;
    delete this.look;
    delete this.now;
    delete this.budgetMs;
    delete this.quickCheckBudgetMs;
    delete this.beforeMove;
    delete this.syncDirectory;
    delete this.captureLock;
    delete this.limits;
  },
};

export function accountFolderMigrationEnabled(env: LayoutEnv = process.env): boolean {
  return env[MIGRATE_ACCOUNT_FOLDERS_ENV]?.trim() === '1';
}

const MESSAGING_SOURCES: readonly string[] = [TELEGRAM_SOURCE_ID, WHATSAPP_SOURCE_ID];
const isMessaging = (sourceId: string): boolean => MESSAGING_SOURCES.includes(sourceId);

/**
 * What a messaging account's records outside the data folder say about where
 * its session is, gathered before the pass (core/messaging-account-move.ts):
 * the capture grant, the session paths the secret store holds and an Unpair
 * that did not finish. `pin` keeps the account where it is because one of them
 * names another place; `unreadable` because one cannot be read. A messaging
 * source with no facts is not considered at all.
 */
export interface MessagingMoveFacts {
  pin?: string;
  unreadable?: string;
}

export interface AccountMigrationOptions {
  messaging?: Partial<Record<string, MessagingMoveFacts>>;
}

/** The name of the lock a WhatsApp bridge holds in its state folder (`raw/whatsapp/bridge.lock`), through the descriptor its spawner hands it. */
export const WHATSAPP_BRIDGE_LOCK_NAME = 'bridge.lock';
/** The lock the Telegram reader takes in its gateway state folder (`scripts/telegram-telethon-reader.py`, `gateway_process_lock`). */
export const TELEGRAM_GATEWAY_LOCK_NAME = 'gateway.lock';

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
      const to = file.folderPath
        ? join(accountFolder(account, env), ...file.folderPath.split('/'))
        : accountRawPath(account, file.name as AccountRawName, env);
      add('raw', file.legacy, to, file.rawKind === 'dir' ? 'dir' : 'file', file.rawKind === 'db');
    }
  }
  if (sourceId === TELEGRAM_SOURCE_ID) {
    // Logins a killed pairing left aside go with the login they were made from
    // (Unpair and the next pairing find them by its name). Looked for in both
    // places, so a plan part way is checked against the same list.
    const legacyDir = dirname(legacyTelegramSessionBase(env));
    const folderDir = join(accountFolder(account, env), 'session');
    const own = basename(legacyTelegramSessionBase(env));
    const staged = new Set<string>();
    for (const name of listNames(legacyDir)) if (folderNameOfStagedTelegramLogin(name, env)) staged.add(name);
    for (const name of listNames(folderDir)) {
      const legacyName = name.startsWith('telegram.pairing-') ? `${own}${name.slice('telegram'.length)}` : undefined;
      if (legacyName && folderNameOfStagedTelegramLogin(legacyName, env)) staged.add(legacyName);
    }
    for (const name of [...staged].sort()) {
      found.push({ role: 'raw', from: join(legacyDir, name), to: join(folderDir, folderNameOfStagedTelegramLogin(name, env)!), kind: 'file', db: false });
    }
  }
  return found;
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
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
  /** The folders legacy files sit in, the data root first (`migrationPathRoots`). */
  roots: Array<{ tag: string; root: string }>;
  messaging: Partial<Record<string, MessagingMoveFacts>> | undefined;
  now: () => number;
  /** When the boot stops starting accounts, and stops waiting for other connections. */
  deadline: number;
  quickCheckSpentMs: number;
  quickCheckBudgetMs: number;
  /** Bytes `PRAGMA quick_check` has read so far this boot. */
  quickCheckBytes: number;
}

/** The folder of `migrationPathRoots` that holds a path (the first one, the data root before the others), and the path below it. */
function rootOf(ctx: Pick<Context, 'roots'>, path: string): { tag: string; root: string; below: string } | undefined {
  for (const { tag, root } of ctx.roots) {
    const below = relative(root, path);
    if (below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) continue;
    return { tag, root, below };
  }
  return undefined;
}

/**
 * Paths in the registry are written with `/` relative to the data root, or, for
 * a messaging account's files outside it, as `@<tag>/...` relative to the
 * folder that tag names (`migrationPathRoots`), so the file never names a home
 * folder.
 */
function relPath(ctx: Pick<Context, 'roots'>, path: string): string {
  const at = rootOf(ctx, path);
  if (!at) throw new TypeError('A migration path must sit in a folder the layout names.');
  const below = at.below.split(sep).join('/');
  return at.tag ? `@${at.tag}/${below}` : below;
}

function absPath(ctx: Pick<Context, 'roots' | 'root'>, rel: string): string {
  if (!rel.startsWith('@')) return join(ctx.root, ...rel.split('/'));
  const slash = rel.indexOf('/');
  const tag = rel.slice(1, slash < 0 ? undefined : slash);
  const root = ctx.roots.find((candidate) => candidate.tag === tag && tag !== '')?.root;
  if (root === undefined || slash < 0) throw new TypeError(`A migration path names a folder this build does not know (${JSON.stringify(tag)}).`);
  return join(root, ...rel.slice(slash + 1).split('/'));
}

const checkpoint = (at: string): void => __accountMigrationTestHooks.checkpoint?.(at);

/** How long one checkpoint or open may wait for another connection: the cap, and no more than the boot's deadline leaves. */
const waitMs = (ctx: Context): number => Math.max(0, Math.min(LOCK_WAIT_CAP_MS, ctx.deadline - ctx.now()));

const limit = (name: 'quickCheckStoreMaxBytes' | 'quickCheckTotalMaxBytes' | 'accountLogMaxBytes', fallback: number): number =>
  __accountMigrationTestHooks.limits?.[name] ?? fallback;

/** Errors that mean "this file system makes no hard links", not "this file cannot move". */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK']);

const syncFolder = (path: string): void => (__accountMigrationTestHooks.syncDirectory ?? syncDirectorySync)(path);

/**
 * Moves one file or folder to a place nothing else may already hold, and never
 * leaves it without a durable name. A file is linked to its new name (which
 * fails with `EEXIST` if the name is taken, where a rename would replace what is
 * there), the folder that now holds the new name is fsynced, and only then is the
 * old name removed: whatever a power failure persists, the file has a name that
 * survives. A kill between the link and the unlink leaves one file under two
 * names, which the next call finishes (`moveOne`). A file system that makes no
 * hard links is not worked around: the error ends the move (`moveOne` reads it as
 * the account's skip). Node has no portable no-replace rename for folders:
 * `rename(2)` of a folder fails onto a non-empty folder or any file, and replaces
 * only an EMPTY folder, which another process would have to have made in the
 * instant since the look. A folder is moved by one rename that changes two
 * parents, and both are fsynced before anything else is done.
 */
function moveWithoutReplacing(from: string, to: string, kind: 'file' | 'dir'): void {
  if (kind === 'dir') {
    renameSync(from, to);
    syncFolder(dirname(to));
    syncFolder(dirname(from));
    return;
  }
  (__accountMigrationTestHooks.link ?? linkSync)(from, to);
  syncFolder(dirname(to));
  unlinkSync(from);
}

const moveFile = (from: string, to: string, kind: 'file' | 'dir'): void =>
  (__accountMigrationTestHooks.rename ?? moveWithoutReplacing)(from, to, kind);

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
  | { kind: 'move'; moves: SourceRegistryMove[] };

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
 * A path's real path whether or not the file is there: the real path of the
 * nearest folder above it that exists, then the rest of the path.
 */
function nearRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Fall through: it is not there.
  }
  const rest: string[] = [];
  let near = resolve(path);
  for (;;) {
    rest.unshift(basename(near));
    const up = dirname(near);
    if (up === near) return resolve(path);
    near = up;
    try {
      return join(realpathSync(near), ...rest);
    } catch {
      // Keep climbing to a folder that is there.
    }
  }
}

/**
 * Whether every folder between the data root and a destination is a real
 * folder, or not there yet: none is a link that would take the file somewhere
 * else on the same device. The check Delete makes of an account folder (the
 * real path must be the lexical path under the data root's real path).
 */
function destinationIsOurs(ctx: Context, destination: string): boolean {
  const parent = dirname(destination);
  // A messaging account's old places are below the capture or the state root, which are checked the same way.
  const at = rootOf(ctx, parent);
  if (!at) return false;
  return nearRealPath(parent) === join(nearRealPath(at.root), at.below);
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

/**
 * Whether something keeps the account where it is before any file is looked
 * at: an env override or a mount, and for messaging the Gateway owning its
 * capture, or its records outside the data folder (a capture grant or a stored
 * session path that names another place, an Unpair that did not finish), or a
 * second WhatsApp state folder (the Gateway service's and the cron sync's
 * ignore `XDG_DATA_HOME`) that is not the one that would move. A capture grant
 * that names the default place does not pin: it is rewritten once the account
 * has moved (core/messaging-account-move.ts).
 */
function pinFor(ctx: Context, sourceId: string): Extract<Inspection, { kind: 'skip' }> | undefined {
  const { env } = ctx;
  const pin = legacyPinFor(sourceId, env, isMessaging(sourceId) ? { captureGrant: false } : {});
  if (pin) return skip('pinned', `${pin} names where its files are, so they stay there.`) as Extract<Inspection, { kind: 'skip' }>;
  if (!isMessaging(sourceId)) return undefined;
  const facts = ctx.messaging?.[sourceId];
  if (facts?.unreadable) return skip('unreadable', facts.unreadable) as Extract<Inspection, { kind: 'skip' }>;
  if (facts?.pin) return skip('pinned', facts.pin) as Extract<Inspection, { kind: 'skip' }>;
  if (sourceId === WHATSAPP_SOURCE_ID) {
    const moving = resolve(legacyWhatsAppDefaultStateDir(env));
    for (const other of [legacyWhatsAppServiceStateDir(env), legacyWhatsAppLiveSyncStateDir(env, env.HOME?.trim() || undefined)]) {
      if (resolve(other) === moving) continue;
      const found = look(other);
      if (found.kind === 'absent') continue;
      if (found.kind === 'unreadable') return skip('unreadable', 'A WhatsApp state folder outside the data folder cannot be looked at.') as Extract<Inspection, { kind: 'skip' }>;
      return skip('files_elsewhere', 'A second WhatsApp state folder sits outside the data folder, so it cannot be told which one is the account\'s.') as Extract<Inspection, { kind: 'skip' }>;
    }
  }
  return undefined;
}

function inspect(ctx: Context, sourceId: string, slot: string, entry: SourceRegistryAccount | undefined): Inspection {
  const { env } = ctx;
  const pinned = pinFor(ctx, sourceId);
  if (pinned) return pinned;
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
    from: relPath(ctx, candidate.from),
    to: relPath(ctx, candidate.to),
    kind: candidate.kind,
    ...(candidate.db ? { db: true as const } : {}),
    dev: String(found.dev),
    ino: String(found.ino),
    size: candidate.kind === 'dir' ? 0 : Number(found.size),
  }));
  return { kind: 'move', moves };
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
function checkDatabases(ctx: Context, moves: SourceRegistryMove[]): { checked: NonNullable<SourceRegistryMigration['checked']> } | { busy: string } {
  const storeMax = limit('quickCheckStoreMaxBytes', QUICK_CHECK_STORE_MAX_BYTES);
  const totalMax = limit('quickCheckTotalMaxBytes', QUICK_CHECK_TOTAL_MAX_BYTES);
  const checked: NonNullable<SourceRegistryMigration['checked']> = [];
  for (const move of moves.filter((candidate) => candidate.db)) {
    const path = absPath(ctx, move.from);
    const reads = storeFileReads(path, waitMs(ctx));
    // Another connection has it: wait for the next boot, rather than again for each way of looking.
    if (reads === 'busy') return { busy: `${basename(move.from)} is in use by another program, so the account stays where it is for now.` };
    if (reads === 'damaged') {
      checked.push({ file: move.to, result: 'damaged' });
      continue;
    }
    const bytes = moves
      .filter((other) => other.from === move.from || other.from === `${move.from}-wal` || other.from === `${move.from}-journal`)
      .reduce((total, other) => total + other.size, 0);
    const estimateMs = (bytes / ASSUMED_BYTES_PER_SECOND) * 1000;
    if (bytes > storeMax || ctx.quickCheckBytes + bytes > totalMax || ctx.quickCheckSpentMs + estimateMs > ctx.quickCheckBudgetMs) {
      checked.push({ file: move.to, result: 'not_checked' });
      continue;
    }
    const started = ctx.now();
    const result = storeFileQuickCheck(path, waitMs(ctx));
    ctx.quickCheckSpentMs += ctx.now() - started;
    ctx.quickCheckBytes += bytes;
    if (result === 'busy') return { busy: `${basename(move.from)} is in use by another program, so the account stays where it is for now.` };
    checked.push({ file: move.to, result });
  }
  return { checked };
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
  let pairs: Set<string>;
  try {
    pairs = new Set(known.map((candidate) => `${relPath(ctx, candidate.from)}\n${relPath(ctx, candidate.to)}`));
  } catch {
    return false;
  }
  return (migration.moves ?? []).every((move) => pairs.has(`${move.from}\n${move.to}`) && !move.from.split('/').includes('..'));
}

/**
 * Makes every folder from the data root down to each of `folders` durable: each
 * one is fsynced, which is what persists the entries in it, so the chain of
 * entries that leads to a file survives a power failure. A folder that was made
 * by an earlier run that died before it synced anything is in the chain like one
 * made now: whether a folder is new or already there says nothing about whether
 * its entry is on disk. A folder that is not there is skipped. Each folder is
 * synced once per call, the root first, by its real path when the data root
 * is a link (a link below the root is never followed: it is not a folder).
 */
function syncFolderChains(ctx: Context, folders: string[]): void {
  const chain = new Set<string>();
  for (const folder of folders) {
    // Each chain starts at the folder of `migrationPathRoots` that holds it: the data root for every destination.
    const at = rootOf(ctx, folder);
    if (!at) throw Object.assign(new Error('outside every root'), { code: 'EINVAL' });
    // That folder may itself be a link: the folders synced are the real ones it leads to.
    let current = realpathSync(at.root);
    chain.add(current);
    for (const part of at.below.split(sep).filter(Boolean)) {
      current = join(current, part);
      chain.add(current);
    }
  }
  for (const folder of chain) {
    if (lookAt(folder).kind === 'dir') syncFolder(folder);
  }
}

/**
 * Makes the folders the files are going to, never through a link: a component
 * that is there must be a real folder. Then the whole chain from the data root
 * to each destination folder is made durable, the folders that were already there
 * included (a run that died after making one and before syncing its parent left
 * an entry that is not on disk), before any file is moved: past this, the first
 * old name that is removed has a destination whose every ancestor survives a
 * power failure.
 */
function makeFolders(ctx: Context, moves: SourceRegistryMove[]): void {
  try {
    const real = realpathSync(ctx.root);
    const destinations = new Set<string>();
    for (const move of moves) {
      const destination = dirname(absPath(ctx, move.to));
      if (!destinationIsOurs(ctx, absPath(ctx, move.to))) throw Object.assign(new Error('link'), { code: 'ELOOP' });
      destinations.add(destination);
      let current = real;
      for (const part of relative(ctx.root, destination).split(sep).filter(Boolean)) {
        current = join(current, part);
        const found = lookAt(current);
        if (found.kind === 'dir') continue;
        if (found.kind !== 'absent') throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
        mkdirSync(current, { mode: 0o700 });
      }
    }
    syncFolderChains(ctx, [...destinations]);
  } catch (error) {
    if (error instanceof AccountMigrationKilled) throw error;
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
    folders.add(dirname(absPath(ctx, move.from)));
    folders.add(dirname(absPath(ctx, move.to)));
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
    for (let folder = dirname(absPath(ctx, move.to)); folder === stop || folder.startsWith(`${stop}${sep}`); folder = dirname(folder)) {
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
    ? [absPath(ctx, move.from), absPath(ctx, move.to)]
    : [absPath(ctx, move.to), absPath(ctx, move.from)];
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
      // A file made after the plan (a companion the pass moves back) has no recorded identity: one inode under both names is proof enough.
      && source.dev === target.dev && source.ino === target.ino && (move.ino === '' || String(source.ino) === move.ino)
    ) {
      try {
        // The name that stays is made durable before the other one goes, as in the move itself.
        syncFolder(dirname(to));
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
    if (NO_HARD_LINKS.has(code) && move.kind === 'file') {
      throw new MoveFault('skipped', 'no_hard_links', 'The file system the data folder is on does not make hard links, which moving a file safely needs, so the account stays where it is.');
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
    const found = look(absPath(ctx, move.to));
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
    const back = look(absPath(ctx, move.from));
    if (isPlanned(look(absPath(ctx, move.to)), move)) {
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

function forward(ctx: Context, sourceId: string, slot: string, migration: SourceRegistryMigration): void {
  const moves = migration.moves ?? [];
  makeFolders(ctx, moves);
  moves.forEach((move, index) => {
    if (moveOne(ctx, move, 'forward') === 'lost') {
      throw new MoveFault('failed', 'move_failed', `${basename(move.from)} is in neither place.`);
    }
    checkpoint(`rename:${index}`);
  });
  // The renames are on disk before the registry says anything that depends on them.
  syncMoveFolders(ctx, moves);
  verifyIdentity(ctx, moves);
  for (const move of moves) {
    if (move.db !== true || isCompanion(move.from) || stateBefore(migration, move) === 'damaged') continue;
    const reads = storeFileReads(absPath(ctx, move.to), waitMs(ctx));
    // Another program has it open: not a fault of the move. Everything goes back, and the account tries again at the next boot.
    if (reads === 'busy') throw new MoveFault('skipped', 'busy', `${basename(move.from)} is in use by another program, so the account stays where it is for now.`);
    if (reads !== 'reads') {
      throw new MoveFault('failed', 'verify_failed', `${basename(move.from)} does not open after the move.`);
    }
  }
  checkpoint('verified');
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
  removeEmptiedLegacyFolders(ctx, sourceId, slot);
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
  // The folders the files go back to are made durable first, as the account folder's were: nothing is removed from the account
  // folder before the places the files return to have survived a power failure.
  try {
    syncFolderChains(ctx, moves.map((move) => dirname(absPath(ctx, move.from))));
  } catch (error) {
    if (error instanceof AccountMigrationKilled) throw error;
    throw new MoveFault('failed', 'move_failed', `The folders the files go back to could not be made durable (${errorCode(error)}).`);
  }
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

/** Finishes or undoes a plan the registry holds. */
function runPlan(ctx: Context, account: SourceRegistryAccount, options: { locksHeld?: boolean } = {}): Outcome {
  const migration = account.migration!;
  const { source_id: sourceId, slot } = account;
  if (!migratableSources().includes(sourceId) || !planIsCanonical(ctx, sourceId, slot, migration)) {
    return { kind: 'stuck', detail: 'Its move plan is not one this build wrote, so nothing was touched.' };
  }
  // The move that wrote the plan holds them already (a second `flock` in this process would find them taken).
  if (options.locksHeld) return runHeldPlan(ctx, sourceId, slot, migration);
  // A capture helper that runs now holds its files: the plan waits for a boot at which none does.
  const locks = holdCaptureLocks(ctx, sourceId, slot);
  if (!Array.isArray(locks)) return { kind: 'skipped', reason: locks.reason };
  try {
    return runHeldPlan(ctx, sourceId, slot, migration);
  } finally {
    for (const lock of locks) lock.release();
  }
}

function runHeldPlan(ctx: Context, sourceId: string, slot: string, migration: SourceRegistryMigration): Outcome {
  try {
    if (migration.state === 'reverting') {
      const reason = migration.reason ?? 'verify_failed';
      throw new MoveFault(SKIP_REASONS.has(reason) ? 'skipped' : 'failed', reason, migration.detail ?? 'A move was undone.');
    }
    forward(ctx, sourceId, slot, migration);
    return { kind: 'moved' };
  } catch (error) {
    if (error instanceof AccountMigrationKilled || error instanceof EntryChanged) throw error;
    const fault = error instanceof MoveFault
      ? error
      : new MoveFault('failed', 'move_failed', `The move stopped unexpectedly (${errorCode(error)}).`);
    try {
      revert(ctx, sourceId, slot, migration, fault);
    } catch (revertError) {
      if (revertError instanceof AccountMigrationKilled || revertError instanceof EntryChanged) throw revertError;
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

/**
 * Folds every database's write-ahead log into the database
 * (`PRAGMA wal_checkpoint(TRUNCATE)`, in core/source-storage.ts), so that what
 * moves is whole files: the database file holds everything and a `-wal` or
 * `-shm` that is lost in the move costs nothing. Ends the account's fold at the
 * first database that cannot be folded completely (another connection has it
 * open, or not every frame could be checkpointed): the account stays where it is
 * this boot, and says why. A file that is not a database is left alone when it
 * has no log to lose (it is moved as the opaque file it is, and recorded as
 * damaged by the check); one with a log that cannot be folded is a skip too.
 */
function foldLogs(ctx: Context, moves: SourceRegistryMove[]): Extract<Inspection, { kind: 'skip' }> | undefined {
  const notFolded = (detail: string): Extract<Inspection, { kind: 'skip' }> => ({ kind: 'skip', reason: 'log_not_folded', detail });
  for (const move of moves) {
    if (move.db !== true || isCompanion(move.from)) continue;
    const path = absPath(ctx, move.from);
    const result = storeFileCheckpoint(path, waitMs(ctx));
    if (result === 'folded') continue;
    if (result === 'not_a_database') {
      // Nothing to fold into: fine unless it has log bytes that would be lost with it.
      const logs = moves.filter((other) => other.from === `${move.from}-wal` || other.from === `${move.from}-journal`);
      if (logs.every((log) => log.size === 0)) continue;
      return notFolded(`${basename(move.from)} is not a database, and it has a log that would be lost, so the account stays where it is.`);
    }
    if (result === 'busy') {
      return { kind: 'skip', reason: 'busy', detail: `${basename(move.from)} is in use by another program, so its write-ahead log could not be folded into it; the account stays where it is for now.` };
    }
    return notFolded(`${basename(move.from)}'s write-ahead log could not be folded into it, so the account stays where it is.`);
  }
  return undefined;
}

/**
 * The locks a messaging account's capture helper holds while it runs, taken at
 * both places its state folder can be (the old one and the account folder's):
 * Telegram's reader takes `gateway.lock` in its gateway state, and a WhatsApp
 * bridge holds `bridge.lock` in its state folder through the descriptor its
 * spawner hands it (core/messaging-capture.ts). Held through the account's whole
 * pass, so no helper starts on the files while they move (one that tries finds
 * the lock taken and exits, to be started again later). A lock another process
 * holds is `busy`: the account stays where it is this boot. Only a folder that
 * is there gets a lock file; it moves with the folder.
 */
function holdCaptureLocks(ctx: Context, sourceId: string, slot: string): HeldFileFlock[] | Extract<Inspection, { kind: 'skip' }> {
  if (!isMessaging(sourceId)) return [];
  const account: LayoutAccount = { source_id: sourceId, slot, layout: 'folder' };
  const telegram = sourceId === TELEGRAM_SOURCE_ID;
  const legacyDir = legacyAccountFiles(sourceId, ctx.env).find((file) => file.name === (telegram ? 'telegram-gateway' : 'whatsapp'))!.legacy;
  const dirs = [legacyDir, accountRawPath(account, telegram ? 'telegram-gateway' : 'whatsapp', ctx.env)];
  const name = telegram ? TELEGRAM_GATEWAY_LOCK_NAME : WHATSAPP_BRIDGE_LOCK_NAME;
  const held: HeldFileFlock[] = [];
  const giveBack = (inspection: Inspection): Extract<Inspection, { kind: 'skip' }> => {
    for (const lock of held) lock.release();
    return inspection as Extract<Inspection, { kind: 'skip' }>;
  };
  for (const dir of dirs) {
    if (lookAt(dir).kind !== 'dir') continue;
    let lock: HeldFileFlock | undefined;
    try {
      lock = (__accountMigrationTestHooks.captureLock ?? tryHoldFileFlock)(join(dir, name));
    } catch {
      return giveBack(skip('unreadable', `Its capture lock (${name}) cannot be taken.`));
    }
    if (!lock) {
      return giveBack(skip('busy', `Its ${telegram ? 'Telegram reader' : 'WhatsApp bridge'} is running, so the account stays where it is for now.`));
    }
    held.push(lock);
  }
  return held;
}

/**
 * After a messaging account's move: the old folders it emptied (Telegram's
 * `telegram/` and `telegram-capture/` in the capture root) are removed, so
 * nothing is left at the old place. One that holds anything stays, and so does
 * every root. Run again at each boot for an account a move finished, in case a
 * boot stopped between the flip and this.
 */
function removeEmptiedLegacyFolders(ctx: Context, sourceId: string, slot: string): void {
  if (!isMessaging(sourceId)) return;
  const rootFolders = new Set(ctx.roots.map(({ root }) => resolve(root)));
  const folders = new Set<string>();
  try {
    for (const candidate of candidates(sourceId, slot, ctx.env)) {
      const folder = resolve(dirname(candidate.from));
      if (!rootFolders.has(folder) && rootOf(ctx, folder)) folders.add(folder);
    }
  } catch {
    return;
  }
  for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
    if (lookAt(folder).kind !== 'dir') continue;
    try {
      rmdirSync(folder);
      syncFolder(dirname(folder));
    } catch {
      // Not empty, or already gone.
    }
  }
}

function startMove(ctx: Context, sourceId: string, slot: string, entry: SourceRegistryAccount | undefined): Outcome {
  const pinned = pinFor(ctx, sourceId);
  if (pinned) {
    recordSkip(ctx, sourceId, slot, entry, pinned);
    return { kind: 'skipped', reason: pinned.reason };
  }
  const locks = holdCaptureLocks(ctx, sourceId, slot);
  if (!Array.isArray(locks)) {
    recordSkip(ctx, sourceId, slot, entry, locks);
    return { kind: 'skipped', reason: locks.reason };
  }
  try {
    return startHeldMove(ctx, sourceId, slot, entry);
  } finally {
    for (const lock of locks) lock.release();
  }
}

function startHeldMove(ctx: Context, sourceId: string, slot: string, entry: SourceRegistryAccount | undefined): Outcome {
  let inspection = inspect(ctx, sourceId, slot, entry);
  if (inspection.kind === 'move') {
    // The logs are folded into the databases first, so that what is planned and moved is whole files.
    const unfolded = foldLogs(ctx, inspection.moves);
    if (unfolded) {
      recordSkip(ctx, sourceId, slot, entry, unfolded);
      return { kind: 'skipped', reason: unfolded.reason };
    }
    checkpoint('folded');
    // Reading a database can make its `-shm`, so look again afterwards: the plan names what is there.
    const looked = checkDatabases(ctx, inspection.moves);
    if ('busy' in looked) {
      const busy = skip('busy', looked.busy) as Extract<Inspection, { kind: 'skip' }>;
      recordSkip(ctx, sourceId, slot, entry, busy);
      return { kind: 'skipped', reason: busy.reason };
    }
    const { checked } = looked;
    inspection = inspect(ctx, sourceId, slot, entry);
    // A log with bytes in it again: someone is writing, so the folded file is no longer the whole database.
    if (inspection.kind === 'move' && inspection.moves.some((move) => move.db !== true && (move.from.endsWith('-wal') || move.from.endsWith('-journal')) && move.size > 0)) {
      inspection = skip('log_not_folded', 'A store was written to while its write-ahead log was being folded, so the account stays where it is for now.');
    }
    if (inspection.kind === 'move') {
      const { moves } = inspection;
      updateAccount(ctx, sourceId, slot, (account) => {
        if (account.layout !== 'legacy' || sourceAccountMovePending(account)) throw new EntryChanged();
        account.migration = { state: 'moving', at: new Date(ctx.now()).toISOString(), moves, ...(checked.length > 0 ? { checked } : {}) };
      }, { create: true });
      checkpoint('plan');
      return runPlan(ctx, readSourceRegistryAccount(ctx, sourceId, slot), { locksHeld: true });
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

function context(env: LayoutEnv, options: AccountMigrationOptions): Context | undefined {
  let root: string;
  let roots: Context['roots'];
  try {
    root = olympusDataRoot(env);
    roots = migrationPathRoots(env);
  } catch {
    return undefined; // The data folder cannot be worked out here.
  }
  if (!isAbsolute(root)) return undefined;
  const now = __accountMigrationTestHooks.now ?? Date.now;
  return {
    env,
    root,
    // A root a relative XDG value names would anchor to wherever the process runs: such a place is never one the plan names.
    roots: roots.filter((candidate) => isAbsolute(candidate.root)),
    messaging: options.messaging,
    now,
    deadline: Number.POSITIVE_INFINITY,
    quickCheckSpentMs: 0,
    quickCheckBudgetMs: __accountMigrationTestHooks.quickCheckBudgetMs ?? QUICK_CHECK_BUDGET_MS,
    quickCheckBytes: 0,
  };
}

/**
 * Worker boot, under the owner lock, before anything mounts. Finishes or undoes
 * any plan the registry holds, then (with the switch on) starts moving each
 * legacy account of a migratable source until the budget runs out. A messaging
 * account is started only when `options.messaging` has its facts (the worker's
 * boot gathers them, core/messaging-account-move.ts). Throws what the registry
 * throws when it cannot be read: then nothing is known about any account, and
 * the caller carries on as it always did.
 */
export function migrateAccountFolders(env: LayoutEnv = process.env, options: AccountMigrationOptions = {}): AccountMigrationReport {
  const report: AccountMigrationReport = { moved: [], resumed: [], movedBack: [], skipped: [], stuck: [], deferred: [], errors: [] };
  const registry = readSourceRegistry(env);
  const ctx = context(env, options);
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
  // The same deadline ends the waits for other connections: an open or checkpoint waits no longer than what is left of it.
  ctx.deadline = deadline;
  for (const account of registry.accounts.filter(sourceAccountMovePending)) {
    handled.add(account.source_id);
    if (ctx.now() >= deadline) {
      report.deferred.push(account.source_id);
      continue;
    }
    run(account.source_id, () => runPlan(ctx, account), true);
  }
  // A messaging account a move finished: what a boot that stopped right after the flip left at the old place goes.
  for (const account of readSourceRegistry(env).accounts) {
    if (isMessaging(account.source_id) && account.state === 'active' && account.layout === 'folder' && account.migration?.state === 'done') {
      removeEmptiedLegacyFolders(ctx, account.source_id, account.slot);
    }
  }
  if (!accountFolderMigrationEnabled(env)) return report;
  for (const sourceId of migratableSources()) {
    if (handled.has(sourceId)) continue;
    if (isMessaging(sourceId) && ctx.messaging?.[sourceId] === undefined) continue;
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
