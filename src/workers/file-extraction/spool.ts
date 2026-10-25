/**
 * The private folder where a source writes an item for a file reader
 * (`FileExtractionSource.fetchFile`). Source-neutral: nothing here names a
 * source, and the runner owns every file in it.
 *
 * A scratch file is raw content (a recording, a part of a message) and is
 * written under its owner: `<spool>/c-<corpus>/a-<account scope>/`, each name
 * a digest, so the folder says whose it is without holding a name. Its own
 * name starts with the process that wrote it. That makes three things
 * possible that a flat folder of anonymous files was not: removing one
 * owner's files when its account scope or source is removed
 * (`forgetExtractionSpool`), telling at start which files a dead process left
 * behind, and telling which belong to an owner that has no job left.
 *
 * Doc comments here are always multi-line blocks.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/**
 * A file left in the spool this long is the leftover of a crash (a read
 * removes its own file when it ends), whoever wrote it, and is removed at
 * start. A file whose writer is known to be gone is removed at once.
 */
export const EXTRACTION_SPOOL_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Whose scratch file it is: the corpus the job is in and the account scope of
 * the item (an imported archive's id, a connected account).
 */
export interface ExtractionSpoolOwner {
  corpusId: string;
  accountScope: string;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32);
const corpusFolder = (corpusId: string): string => `c-${digest(corpusId)}`;
const accountFolder = (accountScope: string): string => `a-${digest(accountScope)}`;

/**
 * The folder a source writes this owner's scratch files in.
 */
export function extractionSpoolOwnerDir(root: string, owner: ExtractionSpoolOwner): string {
  return join(root, corpusFolder(owner.corpusId), accountFolder(owner.accountScope));
}

/**
 * The owner as the sweep names it: `c-…/a-…`.
 */
export function extractionSpoolOwnerKey(owner: ExtractionSpoolOwner): string {
  return `${corpusFolder(owner.corpusId)}/${accountFolder(owner.accountScope)}`;
}

/**
 * Removes the owner's folder once it holds nothing, and its corpus folder once
 * that holds nothing. Never throws, and never removes a folder with a file in
 * it: a writer racing this retries its own folder (`readItemToFile`).
 */
export function pruneExtractionSpoolOwner(root: string, owner: ExtractionSpoolOwner): void {
  for (const dir of [extractionSpoolOwnerDir(root, owner), join(root, corpusFolder(owner.corpusId))]) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

function filesUnder(path: string): number {
  try {
    if (!statSync(path).isDirectory()) return 1;
    return readdirSync(path).reduce((total, name) => total + filesUnder(join(path, name)), 0);
  } catch {
    return 0;
  }
}

/**
 * Removes the scratch files of the named owners: every account scope of the
 * corpora (a source being removed) or just the named account scopes inside
 * them (an archive removed from a corpus its family shares). Returns the
 * number of files removed (or, in a dry run, found). Another owner's files are
 * never touched.
 */
export function forgetExtractionSpool(
  root: string,
  scope: { corpusIds: readonly string[]; accountScopes?: readonly string[] },
  options: { dryRun?: boolean } = {},
): number {
  if (!existsSync(root)) return 0;
  const dryRun = options.dryRun === true;
  let removed = 0;
  for (const corpusId of new Set(scope.corpusIds)) {
    const corpusDir = join(root, corpusFolder(corpusId));
    const targets = scope.accountScopes === undefined
      ? [corpusDir]
      : [...new Set(scope.accountScopes)].map((accountScope) => join(corpusDir, accountFolder(accountScope)));
    for (const target of targets) {
      if (!existsSync(target)) continue;
      removed += filesUnder(target);
      if (!dryRun) rmSync(target, { recursive: true, force: true });
    }
    if (!dryRun) {
      try {
        rmdirSync(corpusDir);
      } catch {
        // Another account scope's files are in it, or it is already gone.
      }
    }
  }
  return removed;
}

/**
 * Whether a process is running. A process we may not signal is running; a
 * process that is not there is not.
 */
export function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The name of a scratch file this process writes: the process first, so a
 * later start can tell whose it was.
 */
export function extractionSpoolFileName(): string {
  return `spool-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function writerOf(name: string): number | undefined {
  const prefix = 'spool-';
  if (!name.startsWith(prefix)) return undefined;
  const end = name.indexOf('-', prefix.length);
  if (end < 0) return undefined;
  const digits = name.slice(prefix.length, end);
  return digits.length > 0 && [...digits].every((char) => char >= '0' && char <= '9') ? Number(digits) : undefined;
}

export interface PrepareExtractionSpoolOptions {
  now?: () => number;
  /**
   * Whether the process that wrote a file is still running; defaults to a
   * signal-0 probe.
   */
  processRunning?: (pid: number) => boolean;
  /**
   * The owners (`extractionSpoolOwnerKey`) that still have a job. A folder of
   * an owner with none is the leftover of a removed account scope or source,
   * and goes at once. Asked only when the spool holds an owner folder, and a
   * throw is read as "not known": the folder stays.
   */
  ownersWithJobs?: () => ReadonlySet<string>;
}

/**
 * Sweeps what a crash left in the spool, if the spool is there: a file whose
 * writing process is gone, a folder of an owner with no job, and anything
 * older than `EXTRACTION_SPOOL_STALE_MS`. It makes nothing: the folder is made
 * by the first scratch file written in it (`makeExtractionSpoolOwnerDir`), so
 * an account that never needs one has no spool folder, and returns the folder
 * either way. It waits for nothing else: another process's reads are in files
 * of a running process, and this one's are in files of its own pid. Never
 * throws: a spool that cannot be swept only means a leftover waits for the
 * next start.
 */
export function prepareExtractionSpool(dir: string, options: PrepareExtractionSpoolOptions = {}): string | undefined {
  const now = options.now ?? Date.now;
  const running = options.processRunning ?? processIsRunning;
  try {
    if (!existsSync(dir)) return dir;
    chmodSync(dir, 0o700);
    let owners: ReadonlySet<string> | null | undefined;
    const ownersWithJobs = (): ReadonlySet<string> | null => {
      if (owners !== undefined) return owners;
      try {
        owners = options.ownersWithJobs?.() ?? null;
      } catch {
        owners = null;
      }
      return owners;
    };
    const stale = (path: string): boolean => {
      try {
        return now() - statSync(path).mtimeMs > EXTRACTION_SPOOL_STALE_MS;
      } catch {
        return false;
      }
    };
    const orphan = (name: string, path: string): boolean => {
      const writer = writerOf(name);
      return (writer !== undefined && !running(writer)) || stale(path);
    };
    const remove = (path: string): void => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Tried again at the next start.
      }
    };
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let isDirectory = false;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      // The first layout wrote anonymous files straight into the folder.
      if (!isDirectory) {
        if (orphan(name, path)) remove(path);
        continue;
      }
      if (!name.startsWith('c-')) {
        if (stale(path)) remove(path);
        continue;
      }
      for (const account of readdirSync(path)) {
        const accountDir = join(path, account);
        const live = ownersWithJobs();
        if (live && !live.has(`${name}/${account}`)) {
          remove(accountDir);
          continue;
        }
        let files: string[] = [];
        try {
          files = readdirSync(accountDir);
        } catch {
          continue;
        }
        for (const file of files) {
          const filePath = join(accountDir, file);
          if (orphan(file, filePath)) remove(filePath);
        }
        try {
          rmdirSync(accountDir);
        } catch {
          // Holds a file of a running reader.
        }
      }
      try {
        rmdirSync(path);
      } catch {
        // Holds an owner that is still reading.
      }
    }
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * Takes back a scratch file a read wrote, with its owner's folder and that
 * folder's corpus folder if nothing else is in them. Never throws, and never
 * removes the spool itself.
 */
export function discardExtractionSpoolFile(path: string, ownerDir: string): void {
  rmSync(path, { force: true });
  for (const dir of [ownerDir, dirname(ownerDir)]) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

/**
 * Makes the owner's folder before a scratch file is written in it.
 *
 * With an `anchor` (the account's own folder, which must be there) every
 * folder from the anchor down to the owner's is made one level at a time,
 * owner-only, and a level that is already there is left as it is. The anchor
 * itself is never made: if the account's folder has been deleted under a
 * running worker the write is refused with `ENOENT` (and no folder comes back),
 * rather than bringing the deleted account folder back. Without an anchor (the
 * spool shared by accounts that keep no folder) the whole path is made.
 */
export function makeExtractionSpoolOwnerDir(ownerDir: string, anchor?: string): void {
  if (anchor === undefined) {
    mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
    return;
  }
  const levels = relative(anchor, ownerDir);
  if (levels === '' || levels.startsWith('..') || isAbsolute(levels)) {
    throw new Error('The extraction spool folder is not inside its account folder.');
  }
  let anchored = false;
  try {
    anchored = statSync(anchor).isDirectory();
  } catch {
    anchored = false;
  }
  if (!anchored) throw new Error('The extraction spool folder is gone.');
  let path = anchor;
  for (const level of levels.split(sep)) {
    path = join(path, level);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
