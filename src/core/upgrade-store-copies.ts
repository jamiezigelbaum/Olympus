// The copies an upgrade takes of every store, made by `olympus worker upgrade`
// itself after the previous version has stopped and before the new one
// starts. A stopped store is copied as a file: checkpointed first, then cloned
// where the disk can (APFS, btrfs, XFS: instant) or copied plainly. Nothing of
// this runs in the engine's boot or on its loop, where a VACUUM INTO of every
// store took 37 minutes at 39 GB and held the engine's only thread.
//
// Each copy is `<store>.pre-schema-upgrade.bak`, written as a `.partial` and
// renamed into place, and recorded with the boot's own backups
// (boot-progress.ts), so a failed upgrade puts it back and a successful one
// removes it the same way. The engine's boot finds the copy and takes none of
// its own for that file.

import { spawnSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, readdirSync, renameSync, rmSync, statfsSync, statSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordSchemaBackup, removeAbandonedBackupCopies } from './boot-progress.ts';
import { olympusDataRoot, type LayoutEnv } from './olympus-layout.ts';
import { OperationError } from './operation-error.ts';

export const UPGRADE_COPY_SUFFIX = '.pre-schema-upgrade.bak';
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
  checkpointStores(stores, options.bunBin);
  const bytes = stores.reduce((sum, file) => sum + statSync(file).size, 0);
  const free = (options.freeBytes ?? defaultFreeBytes)(dirname(stores[0]!));
  if (free < bytes + SPACE_MARGIN_BYTES) {
    throw new OperationError(
      'config_error',
      `The upgrade copies your stores before it updates them: that needs ${formatBytes(bytes + SPACE_MARGIN_BYTES)} free, and ${formatBytes(free)} is free.`,
      'Free up space on that disk, then run the upgrade again. Nothing was changed.',
    );
  }
  options.log?.(`Copying ${stores.length} stores (${formatBytes(bytes)}) before the update.`);
  const made: string[] = [];
  try {
    for (const file of stores) {
      const copy = upgradeCopyPath(file);
      removeAbandonedBackupCopies(copy);
      const partial = `${copy}.${process.pid}.partial`;
      rmSync(partial, { force: true });
      // Recorded before the copy starts, so a delete or forget finds one a crash left part way.
      recordSchemaBackup(env, { storeId: 'upgrade', dbPath: file, backupPath: copy });
      // A clone where the disk has one, else a plain copy.
      copyFileSync(file, partial, constants.COPYFILE_FICLONE);
      chmodSync(partial, 0o600);
      // A clone keeps the store's own times; the rollback finds copies by when they were made.
      const now = new Date();
      utimesSync(partial, now, now);
      renameSync(partial, copy);
      made.push(copy);
    }
  } catch (error) {
    for (const copy of made) rmSync(copy, { force: true });
    throw error;
  }
  return { stores: stores.length, bytes, ms: Math.round(performance.now() - started) };
}

/** Whether the upgrade copied this store before the running boot: the boot then takes no copy of its own. */
export function upgradeCopyExists(dbPath: string): boolean {
  return existsSync(upgradeCopyPath(dbPath));
}

/**
 * Folds each store's WAL into it, so the file alone is the store. Run in a
 * child Bun process: this module is loaded where bun:sqlite is not.
 */
function checkpointStores(stores: string[], bunBin: string | undefined): void {
  const withWal = stores.filter((file) => { try { return statSync(`${file}-wal`).size > 0; } catch { return false; } });
  if (withWal.length === 0) return;
  const executable = bunBin ?? (typeof Bun !== 'undefined' ? process.execPath : 'bun');
  const script = [
    "import { Database } from 'bun:sqlite';",
    'for (const path of JSON.parse(process.argv.at(-1))) {',
    '  const db = new Database(path, { create: false });',
    "  try { db.exec('PRAGMA busy_timeout = 5000;'); const row = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get(); if (row.busy) throw new Error('busy'); }",
    '  finally { db.close(); }',
    '}',
  ].join('\n');
  const result = spawnSync(executable, ['-e', script, JSON.stringify(withWal)], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status !== 0) {
    throw new OperationError(
      'config_error',
      'The upgrade could not fold a store\'s write-ahead log into it before copying it; another process may still have it open.',
      'Run `olympus worker status`, stop anything else using Olympus, then run the upgrade again. Nothing was changed.',
    );
  }
}

function defaultFreeBytes(directory: string): number {
  const stats = statfsSync(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
