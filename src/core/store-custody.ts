/**
 * Store custody: who may have Olympus stores open, enforced by the kernel.
 *
 * Delete indexed data unlinks store files, which is safe only while no process
 * holds them. Asking the process table who runs cannot establish that (titles
 * change, other PID namespaces are invisible, a process can start a moment
 * after the check). Custody is instead one lock the holders themselves keep.
 *
 *  - ONE lock per account home: `<home>/.olympus-locks/store-lifecycle.lock.db`.
 *    It lives outside every directory Olympus data delete removes (the
 *    known roots are `.olympus`, `.config/olympus`, the data/state/cache
 *    folders), so no delete unlinks it, and every opener, whichever store or
 *    subfolder it opens and wherever an override put that store, and the
 *    recursive deleter all meet on the same inode. The data-lifecycle fence
 *    refuses any delete target that would contain it.
 *  - Every process that opens a store holds the lock SHARED for its whole
 *    life. All store opens go through core/store-open.ts, which takes it
 *    (a guard test fails when a raw open appears elsewhere). The lock is an
 *    open read transaction; the kernel drops it when the process dies,
 *    SIGKILL included: no PID, no staleness judgement, no cleanup.
 *  - Delete apply (engine host and CLI) takes it EXCLUSIVE, waiting only
 *    briefly. If any opener holds it, the delete refuses and removes nothing.
 *    It keeps it through the delete and the completion record, and an opener
 *    that starts meanwhile waits for it, then is refused.
 *  - The lock database must be in rollback-journal mode (WAL would let an
 *    exclusive transaction coexist with readers); that is enforced before
 *    either lock is granted, and anything else fails closed.
 *
 * One lock per account is deliberately coarse: any live Olympus process on the
 * account blocks a delete, which is what the delete needs. Another account, or
 * another HOME, has a different lock and never interferes.
 */
import { accessSync, constants, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { sleepSync, tryKernelLockAt, type KernelLock } from './file-lease.ts';

const LOCK_DIRECTORY = '.olympus-locks';
const LOCK_FILE_NAME = 'store-lifecycle.lock.db';
const POLL_MS = 50;

/** The lock folder cannot be made safe to use; the message says exactly why. */
export class StoreCustodyUnavailableError extends Error {
  constructor(readonly directory: string, why: string) {
    super(`Olympus cannot use its store lock folder ${directory}: ${why}.`);
  }
}

export class StoreCustodyBusyError extends Error {
  readonly retryable = true;
  constructor() {
    super('Olympus stores are being deleted or are held by another process.');
  }
}

function canonicalHome(homeDir: string | undefined): string {
  const home = resolve(homeDir?.trim() || process.env.HOME?.trim() || homedir());
  try { return realpathSync(home); } catch { return home; }
}

/** The folder that holds the lock (and the delete fence) for the account at `homeDir`. */
export function storeCustodyDirectory(homeDir?: string): string {
  return join(canonicalHome(homeDir), LOCK_DIRECTORY);
}

/**
 * The lock folder, created if missing, and refused unless it is a real folder
 * (never a symbolic link: a link could lead the lock into a tree a delete
 * removes) owned by this user, not writable by group or others, and writable
 * by us. Every refusal names the reason.
 */
export function ensureStoreCustodyDirectory(homeDir?: string): string {
  const directory = storeCustodyDirectory(homeDir);
  if (!existsSync(directory) && lstatOrUndefined(directory) === undefined) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new StoreCustodyUnavailableError(directory, `it does not exist and could not be created (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
  const info = lstatSync(directory);
  if (info.isSymbolicLink()) throw new StoreCustodyUnavailableError(directory, 'it is a symbolic link');
  if (!info.isDirectory()) throw new StoreCustodyUnavailableError(directory, 'it is not a folder');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new StoreCustodyUnavailableError(directory, 'it is owned by another user');
  }
  if ((info.mode & 0o022) !== 0) {
    throw new StoreCustodyUnavailableError(directory, 'other users can write to it (it must be mode 700)');
  }
  try {
    accessSync(directory, constants.W_OK);
  } catch {
    throw new StoreCustodyUnavailableError(directory, 'it is not writable');
  }
  const lock = lstatOrUndefined(join(directory, LOCK_FILE_NAME));
  if (lock?.isSymbolicLink()) throw new StoreCustodyUnavailableError(directory, 'the lock file in it is a symbolic link');
  return directory;
}

function lstatOrUndefined(path: string) {
  try { return lstatSync(path); } catch { return undefined; }
}

/** The lock file for the account at `homeDir` (default: this process's HOME). */
export function storeCustodyLockPath(homeDir?: string): string {
  return join(canonicalHome(homeDir), LOCK_DIRECTORY, LOCK_FILE_NAME);
}

const heldShared = new Map<string, KernelLock>();
/** Lock files this process holds exclusively right now (a delete in progress). */
const heldExclusiveHere = new Set<string>();

function takeShared(lockPath: string, deadline: number, homeDir?: string): void {
  ensureStoreCustodyDirectory(homeDir);
  for (;;) {
    const lock = tryKernelLockAt(lockPath, 'shared');
    if (lock) { heldShared.set(lockPath, lock); return; }
    if (Date.now() >= deadline) throw new StoreCustodyBusyError();
    sleepSync(POLL_MS);
  }
}

/**
 * Hold SHARED custody until this process exits. Waits up to `timeoutMs` while a
 * delete holds it, then throws StoreCustodyBusyError (a supervisor restarts the
 * opener, which then waits again). Repeated calls cost nothing.
 */
export function holdStoreCustodyShared(options: { timeoutMs?: number; homeDir?: string } = {}): void {
  const lockPath = storeCustodyLockPath(options.homeDir);
  // This process is itself the deleter holding the lock exclusively: the
  // stores it opens meanwhile (to read references, clear rows) are its own.
  if (heldShared.has(lockPath) || heldExclusiveHere.has(lockPath)) return;
  takeShared(lockPath, Date.now() + (options.timeoutMs ?? 20_000), options.homeDir);
}

export interface ExclusiveStoreCustody {
  release(): void;
}

/**
 * Take EXCLUSIVE custody, waiting at most `timeoutMs` (default short). Returns
 * undefined when another process holds it, with nothing kept. A shared hold of
 * this same process is set aside meanwhile (SQLite would count it against the
 * exclusive lock) and restored on release or failure.
 */
export function tryHoldStoreCustodyExclusive(
  options: { timeoutMs?: number; homeDir?: string } = {},
): ExclusiveStoreCustody | undefined {
  const lockPath = storeCustodyLockPath(options.homeDir);
  ensureStoreCustodyDirectory(options.homeDir);
  const deadline = Date.now() + (options.timeoutMs ?? 1_500);
  const ownShared = heldShared.get(lockPath);
  if (ownShared) { ownShared.release(); heldShared.delete(lockPath); }
  const restoreShared = () => {
    if (ownShared) { try { takeShared(lockPath, Date.now() + 1_000, options.homeDir); } catch { /* the next opener re-takes it */ } }
  };
  for (;;) {
    const lock = tryKernelLockAt(lockPath, 'exclusive');
    if (lock) {
      heldExclusiveHere.add(lockPath);
      return {
        release() {
          lock.release();
          heldExclusiveHere.delete(lockPath);
          restoreShared();
        },
      };
    }
    if (Date.now() >= deadline) { restoreShared(); return undefined; }
    sleepSync(POLL_MS);
  }
}

/** Test seam: drop this process's shared holds. */
export function releaseHeldStoreCustodyForTests(): void {
  for (const lock of heldShared.values()) lock.release();
  heldShared.clear();
}
