/**
 * Store custody: who may have Olympus stores open, enforced by the kernel.
 *
 * Delete indexed data unlinks store files, which is safe only while no process
 * holds them. Asking the process table who runs (the first design) cannot
 * establish that: titles change, other PID namespaces are invisible, and a
 * process can start a moment after the check. Custody is instead a lock the
 * holders themselves keep.
 *
 *  - Every process that opens connector stores, ledgers or registries holds a
 *    SHARED lock on `store-lifecycle.lock.db` beside the stores it opens, for
 *    its whole lifetime (holdStoreCustodyShared). The lock is an open read
 *    transaction on that file; the kernel drops it when the process dies,
 *    SIGKILL included, so there is no PID, no staleness judgement and no
 *    cleanup (core/file-lease.ts is the same primitive).
 *  - Delete apply (the engine host and the CLI) takes the same locks
 *    EXCLUSIVE, without waiting beyond a short bound. If any is held it
 *    refuses and deletes nothing. It keeps them through the delete and the
 *    completion write, and an opener that starts meanwhile waits on, or is
 *    refused, its SHARED acquire.
 *
 * The lock is keyed to the resolved store directory (parent symlinks resolved),
 * so another installation or another user's stores are different locks and
 * never interfere. For a path P the keys are P's directory, and P itself when P
 * is a directory: an opener that names a store file and a delete that names its
 * state directory meet on the same key.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { sleepSync, tryKernelLockAt, type KernelLock } from './file-lease.ts';

export const STORE_CUSTODY_LOCK_NAME = 'store-lifecycle';
const LOCK_FILE_NAME = `${STORE_CUSTODY_LOCK_NAME}.lock.db`;
const POLL_MS = 50;

export class StoreCustodyBusyError extends Error {
  readonly retryable = true;
  constructor(readonly directory: string) {
    super('Olympus stores in this folder are being deleted or are held by another process.');
  }
}

/** Nearest existing ancestor's real path plus the not-yet-existing remainder. */
function canonical(path: string): string {
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

function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/** The lock directories custody of `path` involves. */
export function storeCustodyDirectories(path: string): string[] {
  const real = canonical(path);
  const dirs = new Set<string>([dirname(real)]);
  if (isDirectory(real)) dirs.add(real);
  return [...dirs];
}

export function storeCustodyLockPath(directory: string): string {
  return join(directory, LOCK_FILE_NAME);
}

function uniqueSortedDirectories(paths: readonly string[]): string[] {
  return [...new Set(paths.flatMap((path) => storeCustodyDirectories(path)))].sort();
}

const heldShared = new Map<string, KernelLock>();
/** Lock files this process holds exclusively right now (a delete in progress). */
const heldExclusiveHere = new Set<string>();

/**
 * Hold SHARED custody of the directories of `paths` until this process exits.
 * Waits up to `timeoutMs` while a delete holds them, then throws
 * StoreCustodyBusyError (a supervisor restarts the opener, which then waits
 * again). Repeated calls for a held directory cost nothing.
 */
export function holdStoreCustodyShared(paths: readonly string[], options: { timeoutMs?: number } = {}): void {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  for (const directory of uniqueSortedDirectories(paths)) {
    const lockPath = storeCustodyLockPath(directory);
    // This process is itself the deleter holding the directory exclusively:
    // the stores it opens meanwhile (to read references, clear rows) are its own.
    if (heldShared.has(lockPath) || heldExclusiveHere.has(lockPath)) continue;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (;;) {
      const lock = tryKernelLockAt(lockPath, 'shared');
      if (lock) { heldShared.set(lockPath, lock); break; }
      if (Date.now() >= deadline) throw new StoreCustodyBusyError(directory);
      sleepSync(POLL_MS);
    }
  }
}

export interface ExclusiveStoreCustody {
  /** The directories held. */
  readonly directories: readonly string[];
  release(): void;
}

/**
 * Take EXCLUSIVE custody of the directories of `paths`, all or nothing, waiting
 * at most `timeoutMs` (default short). Returns undefined when any is held, with
 * nothing kept. Directories that do not exist hold no stores and are skipped.
 */
export function tryHoldStoreCustodyExclusive(
  paths: readonly string[],
  options: { timeoutMs?: number } = {},
): ExclusiveStoreCustody | undefined {
  const deadline = Date.now() + (options.timeoutMs ?? 1_500);
  const directories = uniqueSortedDirectories(paths).filter((directory) => existsSync(directory));
  for (;;) {
    const taken: KernelLock[] = [];
    let blocked = false;
    for (const directory of directories) {
      const lockPath = storeCustodyLockPath(directory);
      const lock = tryKernelLockAt(lockPath, 'exclusive');
      if (!lock) { blocked = true; break; }
      taken.push(lock);
    }
    if (!blocked) {
      const lockPaths = directories.map(storeCustodyLockPath);
      for (const lockPath of lockPaths) heldExclusiveHere.add(lockPath);
      return {
        directories,
        release() {
          for (const lock of taken.splice(0)) lock.release();
          for (const lockPath of lockPaths) heldExclusiveHere.delete(lockPath);
        },
      };
    }
    for (const lock of taken) lock.release();
    if (Date.now() >= deadline) return undefined;
    sleepSync(POLL_MS);
  }
}

/** Test seam: drop this process's shared holds. */
export function releaseHeldStoreCustodyForTests(): void {
  for (const lock of heldShared.values()) lock.release();
  heldShared.clear();
}
