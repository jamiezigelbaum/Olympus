// The copies an upgrade takes of every store, made by `olympus worker upgrade`
// itself after the previous version has stopped and before the new one
// starts. A stopped store is copied as a file, by a child Bun process that
// holds the store's write lock for the copy: any hot rollback journal is
// recovered and the WAL folded in first, then the file is cloned where the
// disk can (APFS, btrfs, XFS: instant) or copied plainly, and synced. Nothing
// of this runs in the engine's boot or on its loop, where a VACUUM INTO of
// every store took 37 minutes at 39 GB and held the engine's only thread.
//
// Each copy is `<store>.pre-schema-upgrade.bak`, written as a `.partial` and
// renamed into place, and recorded with the boot's own backups
// (boot-progress.ts), so a failed upgrade puts it back and a successful one
// removes it the same way. The engine's boot finds the copy and takes none of
// its own for that file.

import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statfsSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { recordSchemaBackup, removeAbandonedBackupCopies, UPGRADE_COPY_SUFFIX } from './boot-progress.ts';
import { olympusDataRoot, type LayoutEnv } from './olympus-layout.ts';
import { OperationError } from './operation-error.ts';

export { UPGRADE_COPY_SUFFIX };
/** Folders under the data root that hold no store: model files and a backup being packed. */
const SKIPPED_FOLDERS = new Set(['models', 'backup-staging']);
/** Room kept free on the disk beyond the copies themselves. */
const SPACE_MARGIN_BYTES = 1024 ** 3;

/** The upgrade copy of the store at `dbPath`. */
export function upgradeCopyPath(dbPath: string): string {
  return `${dbPath}${UPGRADE_COPY_SUFFIX}`;
}

/** Every store file under the data root: `*.sqlite`, not a copy, a journal or a link. */
export function olympusStoreFiles(env: LayoutEnv): string[] {
  const files: string[] = [];
  const walk = (directory: string, top: boolean) => {
    let names: string[];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
      if (top && SKIPPED_FOLDERS.has(name)) continue;
      const path = join(directory, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isDirectory()) walk(path, false);
      else if (stat.isFile() && name.endsWith('.sqlite')) files.push(path);
    }
  };
  walk(olympusDataRoot(env), true);
  return files.sort();
}

/** The stores' size on disk, their WAL files included. */
export function olympusStoreBytes(env: LayoutEnv): number {
  let total = 0;
  for (const file of olympusStoreFiles(env)) {
    for (const path of [file, `${file}-wal`]) {
      try { total += statSync(path).size; } catch { /* no WAL */ }
    }
  }
  return total;
}

/**
 * Copies every store before the new version starts. The engine must be
 * stopped. Throws, changing nothing that stays, when the disk has no room.
 * Returns how many stores were copied and how long it took.
 */
export function copyStoresBeforeUpgrade(env: LayoutEnv, options: {
  bunBin?: string;
  freeBytes?: (directory: string) => number;
  log?: (line: string) => void;
} = {}): { stores: number; bytes: number; ms: number } {
  const started = performance.now();
  const stores = olympusStoreFiles(env);
  if (stores.length === 0) return { stores: 0, bytes: 0, ms: 0 };
  // The WAL is counted too: it is folded into the file before the copy.
  const bytes = olympusStoreBytes(env);
  const free = (options.freeBytes ?? defaultFreeBytes)(dirname(stores[0]!));
  if (free < bytes + SPACE_MARGIN_BYTES) {
    throw new OperationError(
      'config_error',
      `The upgrade copies your stores before it updates them: that needs ${formatBytes(bytes + SPACE_MARGIN_BYTES)} free, and ${formatBytes(free)} is free.`,
      'Free up space on that disk, then run the upgrade again. Nothing was changed.',
    );
  }
  options.log?.(`Copying ${stores.length} stores (${formatBytes(bytes)}) before the update.`);
  const pairs = stores.map((file) => [file, `${upgradeCopyPath(file)}.${process.pid}.partial`] as const);
  const made: string[] = [];
  try {
    for (const [file, partial] of pairs) {
      removeAbandonedBackupCopies(upgradeCopyPath(file));
      rmSync(partial, { force: true });
      // Recorded before the copy starts, so a delete or forget finds one a crash left part way.
      recordSchemaBackup(env, { storeId: relative(olympusDataRoot(env), file), dbPath: file, backupPath: upgradeCopyPath(file) });
    }
    copyUnderWriteLock(pairs, options.bunBin);
    for (const [file, partial] of pairs) {
      chmodSync(partial, 0o600);
      // A clone keeps the store's own times; the rollback finds copies by when
      // they were made, and the boot trusts a copy only if it is not older
      // than its store (upgradeCopyExists).
      const now = new Date();
      utimesSync(partial, now, now);
      renameSync(partial, upgradeCopyPath(file));
      made.push(upgradeCopyPath(file));
    }
    for (const directory of new Set(stores.map((file) => dirname(file)))) syncDirectory(directory);
  } catch (error) {
    for (const [, partial] of pairs) rmSync(partial, { force: true });
    for (const copy of made) rmSync(copy, { force: true });
    throw error;
  }
  return { stores: stores.length, bytes, ms: Math.round(performance.now() - started) };
}

/**
 * Whether the upgrade copied this store before the running boot: the boot then
 * takes no copy of its own. A copy older than its store is one an earlier
 * upgrade left behind (its cleanup failed), and protects nothing now.
 */
export function upgradeCopyExists(dbPath: string): boolean {
  try {
    return statSync(upgradeCopyPath(dbPath)).mtimeMs >= statSync(dbPath).mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Copies each store to its partial file in a child Bun process (this module is
 * loaded where bun:sqlite is not), holding the store's write lock for the
 * copy so nothing else running can change it underneath: reading it first
 * recovers a hot rollback journal, the WAL is folded in, and the copy is
 * synced to disk before the lock is let go.
 */
function copyUnderWriteLock(pairs: ReadonlyArray<readonly [string, string]>, bunBin: string | undefined): void {
  const executable = bunBin ?? (typeof Bun !== 'undefined' ? process.execPath : 'bun');
  const script = [
    "import { Database } from 'bun:sqlite';",
    "import { closeSync, constants, copyFileSync, fsyncSync, openSync } from 'node:fs';",
    'for (const [path, partial] of JSON.parse(process.argv.at(-1))) {',
    '  const db = new Database(path, { readwrite: true, create: false });',
    '  try {',
    "    db.exec('PRAGMA busy_timeout = 5000;');",
    "    db.query('SELECT COUNT(*) FROM sqlite_master').get();",
    "    if (String(db.query('PRAGMA journal_mode').get().journal_mode).toLowerCase() === 'wal') {",
    "      const row = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get(); if (row.busy) throw new Error('busy');",
    '    }',
    "    db.exec('BEGIN IMMEDIATE');",
    '    try {',
    '      copyFileSync(path, partial, constants.COPYFILE_FICLONE);',
    "      const fd = openSync(partial, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }",
    "    } finally { db.exec('ROLLBACK'); }",
    '  } finally { db.close(); }',
    '}',
  ].join('\n');
  const result = spawnSync(executable, ['-e', script, JSON.stringify(pairs)], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status !== 0) {
    const holders = processesHolding(pairs.map(([file]) => file));
    const said = (result.stderr ?? '').trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
    const cause = result.error ? result.error.message : said;
    throw new OperationError(
      'config_error',
      `The upgrade could not copy a store before updating it; ${holders.length > 0 ? `it is open in ${holders.join(', ')}` : 'another process may still have it open'}.${cause ? ` The copy said: ${cause}` : ''}`,
      'Run `olympus worker status`, stop anything else using Olympus, then run the upgrade again. Nothing was changed.',
    );
  }
}

/**
 * The processes that have any of these stores open, as "pid N (name)", read
 * from /proc on Linux; nothing elsewhere. Names only, never a path.
 */
function processesHolding(files: string[]): string[] {
  if (process.platform !== 'linux') return [];
  const wanted = new Set(files.flatMap((file) => [file, `${file}-wal`, `${file}-journal`]));
  const found: string[] = [];
  let pids: string[];
  try { pids = readdirSync('/proc').filter((name) => /^[0-9]+$/.test(name)); } catch { return []; }
  for (const pid of pids) {
    let fds: string[];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    const holds = fds.some((fd) => { try { return wanted.has(readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { return false; } });
    if (!holds) continue;
    let name = '?';
    try { name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { /* gone */ }
    found.push(`pid ${pid} (${name})`);
  }
  return found;
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch {
    // Not every platform syncs a directory; the copies themselves are synced.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function defaultFreeBytes(directory: string): number {
  const stats = statfsSync(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
