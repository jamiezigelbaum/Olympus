// What the worker has done of its boot: how many stores it has updated, and
// when its boot work is done (the split's front opens stores on that receipt).
// Whether a process is alive is the heartbeat's to say (engine-heartbeat.ts),
// never this file's: it is written from the engine's own loop, which a long
// step holds.
//
// The file holds store ids and counts only, never a path, a source name or
// item content. The worker (single, or the split's background) writes it; the
// front never does, since it does not own the data root's boot work. The
// front reports its own start in a second file (front-progress), which the
// upgrade's wait reads for the errors a failing front exits on (#1563).
//
// The store backups each schema update takes are recorded beside it, so a
// failed upgrade can put them back before the previous version starts.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { olympusDataRoot, sharedDataPath, type LayoutEnv } from './olympus-layout.ts';

export const BOOT_PROGRESS_SCHEMA = 'olympus.boot-progress.v1';

/** `failed`: the split front only, written as it exits on an error (#1563). */
export type BootPhase = 'starting' | 'backing_up' | 'migrating' | 'done' | 'failed';

export interface BootProgress {
  schema: typeof BOOT_PROGRESS_SCHEMA;
  pid: number;
  phase: BootPhase;
  storeId?: string;
  startedAt: string;
  updatedAt: string;
  completedStores: number;
  /** The split front only: how many of its starts since it last listened ended in an error. */
  failures?: number;
  /** The split front only: the last such error's code (`front_store_write`) or name, never its message. */
  lastFailure?: string;
}

export interface BootStepEvent {
  phase: BootPhase;
  storeId?: string;
  /** A store finished its schema update. */
  completedStore?: boolean;
}

const WRITE_INTERVAL_MS = 1_000;

// This process's boot: reports count only between beginBootProgress and
// finishBootProgress, so a CLI command or a store opened after boot never
// writes over the worker's file.
let current: ProgressFile | undefined;
// The split front's own start, in a file of its own: it never writes the
// background's boot file (it does not own the data root's boot work), and the
// upgrade's wait reads both (#1563).
let front: ProgressFile | undefined;

interface ProgressFile { env: LayoutEnv; file: 'boot-progress' | 'front-progress'; progress: BootProgress; lastWriteMs: number }

function beginProgress(env: LayoutEnv, file: ProgressFile['file'], now: () => number): ProgressFile {
  const at = new Date(now()).toISOString();
  const started: ProgressFile = {
    env,
    file,
    progress: { schema: BOOT_PROGRESS_SCHEMA, pid: process.pid, phase: 'starting', startedAt: at, updatedAt: at, completedStores: 0 },
    lastWriteMs: 0,
  };
  write(started, now(), true);
  return started;
}

function finishProgress(target: ProgressFile, now: () => number): void {
  target.progress = { ...target.progress, phase: 'done', updatedAt: new Date(now()).toISOString() };
  delete target.progress.storeId;
  write(target, now(), true);
}

/** The worker's boot starts: called once it holds the data-owner lock. */
export function beginBootProgress(env: LayoutEnv = process.env, now: () => number = Date.now): void {
  current = beginProgress(env, 'boot-progress', now);
}

/** The worker's boot work is done (it listens, or the background is ready). */
export function finishBootProgress(now: () => number = Date.now): void {
  if (!current) return;
  finishProgress(current, now);
  current = undefined;
}

/**
 * The split front's start begins. From here until it listens, each store it
 * opens is a step (reportFrontStoreOpened), and an error it exits on is
 * counted, so the upgrade's wait can tell a front that keeps failing.
 */
export function beginFrontProgress(env: LayoutEnv = process.env, now: () => number = Date.now): void {
  // The failures of the starts before this one are carried until a start
  // listens, so a wait can say "the front stopped 7 times with <code>".
  const previous = readFrontProgress(env);
  front = beginProgress(env, 'front-progress', now);
  if (previous?.phase === 'failed' && previous.failures) {
    front.progress = { ...front.progress, failures: previous.failures, ...(previous.lastFailure ? { lastFailure: previous.lastFailure } : {}) };
    write(front, now(), true);
  }
}

/**
 * The front is exiting on an error. Records its code or name only: an error
 * message can carry a path or item text, and this file holds neither.
 */
export function failFrontProgress(error: unknown, now: () => number = Date.now): void {
  if (!front) return;
  const code = (error as { code?: unknown } | undefined)?.code;
  const name = error instanceof Error ? error.name : typeof error;
  const label = typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code
    : /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : 'error';
  front.progress = {
    ...front.progress,
    phase: 'failed',
    updatedAt: new Date(now()).toISOString(),
    failures: (front.progress.failures ?? 0) + 1,
    lastFailure: label,
  };
  write(front, now(), true);
  front = undefined;
}

/** A step of the front's start that is not a store: it has stopped waiting on the background. */
export function reportFrontStep(now: () => number = Date.now): void {
  stepFront(false, now);
}

/** The front opened one store. A no-op outside the front's start. */
export function reportFrontStoreOpened(now: () => number = Date.now): void {
  stepFront(true, now);
}

function stepFront(storeOpened: boolean, now: () => number): void {
  try {
    if (!front) return;
    front.progress = {
      ...front.progress,
      updatedAt: new Date(now()).toISOString(),
      completedStores: front.progress.completedStores + (storeOpened ? 1 : 0),
    };
    write(front, now(), false);
  } catch {
    // Progress is advisory; the start goes on.
  }
}

/** The front listens. */
export function finishFrontProgress(now: () => number = Date.now): void {
  if (!front) return;
  delete front.progress.failures;
  delete front.progress.lastFailure;
  finishProgress(front, now);
  front = undefined;
}

/**
 * Records one boot step. Best effort: it never throws into the caller, and it
 * writes at most once a second except when the phase changes. `env` names the
 * data root of the boot it reports on; a step from another one is ignored.
 */
export function reportBootStep(env: LayoutEnv, event: BootStepEvent, now: () => number = Date.now): void {
  try {
    if (!current || bootProgressPath(env) !== bootProgressPath(current.env)) return;
    const phaseChanged = event.phase !== current.progress.phase || event.completedStore === true;
    current.progress = {
      ...current.progress,
      phase: event.phase,
      updatedAt: new Date(now()).toISOString(),
      completedStores: current.progress.completedStores + (event.completedStore ? 1 : 0),
    };
    if (event.storeId) current.progress.storeId = event.storeId;
    else delete current.progress.storeId;
    write(current, now(), phaseChanged);
  } catch {
    // Progress is advisory; the boot goes on.
  }
}

function write(target: ProgressFile, nowMs: number, force: boolean): void {
  if (!force && nowMs - target.lastWriteMs < WRITE_INTERVAL_MS) return;
  try {
    const path = sharedDataPath(target.file, target.env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(path, `${JSON.stringify(target.progress)}\n`);
    target.lastWriteMs = nowMs;
  } catch {
    // A full or read-only disk: the waits fall back to their ceilings.
  }
}

/**
 * Takes back this boot's receipt that its boot work is done: the background
 * is about to restart (a delete), so no front may open stores on it until the
 * next boot is done.
 */
export function withdrawBootProgress(env: LayoutEnv = process.env): void {
  try { rmSync(bootProgressPath(env), { force: true }); } catch { /* the front then waits on a dead pid's receipt, which it refuses */ }
}

export function readBootProgress(env: LayoutEnv = process.env): BootProgress | undefined {
  return readProgressFile(bootProgressPath(env));
}

/** The split front's start, as beginFrontProgress wrote it. */
export function readFrontProgress(env: LayoutEnv = process.env): BootProgress | undefined {
  return readProgressFile(sharedDataPath('front-progress', env));
}

function readProgressFile(path: string): BootProgress | undefined {
  try {
    return parseProgress(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function readBootProgressAsync(env: LayoutEnv = process.env): Promise<BootProgress | undefined> {
  const path = bootProgressPath(env);
  try {
    return parseProgress(await readFile(path, 'utf8'));
  } catch {
    // Missing, unreadable and malformed receipts do not establish readiness.
    return undefined;
  }
}

function parseProgress(text: string): BootProgress | undefined {
  const value = JSON.parse(text) as Partial<BootProgress>;
  if (value.schema !== BOOT_PROGRESS_SCHEMA || typeof value.pid !== 'number' || typeof value.phase !== 'string'
    || typeof value.startedAt !== 'string' || typeof value.updatedAt !== 'string') return undefined;
  if (value.failures !== undefined && (!Number.isSafeInteger(value.failures) || value.failures < 0)) delete value.failures;
  if (value.lastFailure !== undefined && typeof value.lastFailure !== 'string') delete value.lastFailure;
  return { completedStores: 0, ...value } as BootProgress;
}

/** One line for a person waiting: "Updating your data: N stores done, now <storeId> (Xm)". */
export function bootProgressLine(progress: BootProgress, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(progress.startedAt)) / 60_000));
  const store = progress.storeId ? `, now ${progress.storeId}` : '';
  return `Updating your data: ${progress.completedStores} ${progress.completedStores === 1 ? 'store' : 'stores'} done${store} (${minutes}m)`;
}

/** One line for a person waiting on the front: "Starting Olympus: N stores open (Xm)". */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function bootProgressPath(env: LayoutEnv): string {
  return sharedDataPath('boot-progress', env);
}

/** Folders under the data root that hold no store: model files and a backup being packed. */
const STORELESS_FOLDERS = new Set(['models', 'backup-staging']);

/**
 * Every file under the data root whose name `keep` accepts, links and the store-less folders left out. `strict` throws
 * on a folder or entry it cannot read (a missing data root is empty), for a list whose gaps would read as files made later.
 */
export function dataRootFiles(env: LayoutEnv, keep: (name: string) => boolean, options: { strict?: boolean } = {}): string[] {
  const files: string[] = [];
  const root = olympusDataRoot(env);
  const walk = (directory: string, top: boolean) => {
    let names: string[];
    try { names = readdirSync(directory); } catch (error) {
      if (options.strict && !(top && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
      return;
    }
    for (const name of names) {
      if (top && STORELESS_FOLDERS.has(name)) continue;
      const path = join(directory, name);
      let stat;
      try { stat = lstatSync(path); } catch (error) {
        if (options.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        continue;
      }
      if (stat.isDirectory()) walk(path, false);
      else if (stat.isFile() && keep(name)) files.push(path);
    }
  };
  walk(root, true);
  return files.sort();
}

const COMPANIONS = ['-wal', '-shm', '-journal'] as const;

/** `<path>.pre-schema-retired.bak`: retired state, moved aside rather than deleted, until the upgrade commits. */
export function retiredStateBackupPath(path: string): string {
  return `${path}.pre-schema-retired.bak`;
}

/**
 * Retires a file or folder an earlier version kept (the removed pre-filter's ledger and weights, #1415). A failed
 * update puts the whole data root back (core/data-root-snapshot.ts), so it is removed outright. Returns whether
 * anything was there.
 */
export function retireStatePath(_env: LayoutEnv, _storeId: string, path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

/**
 * Removes the part-way copies of `backup` that a killed backup left
 * (`<backup>.<pid>.partial` and its SQLite sidecars) when that process is
 * gone. A live process's copy is its own (#1563: a background killed mid-backup
 * left 33 MB behind, and its successor wrote a second copy beside it).
 */
export function removeAbandonedBackupCopies(backup: string): number {
  const prefix = `${basename(backup)}.`;
  let names: string[];
  try {
    names = readdirSync(dirname(backup));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)\.partial(?:-journal|-wal|-shm)?$/.exec(name.slice(prefix.length));
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processAlive(pid)) continue;
    rmSync(join(dirname(backup), name), { force: true });
    removed += 1;
  }
  return removed;
}

/** Every pre-update copy of the store at `dbPath` on disk, a copy a crash left part way included. */
export function preSchemaBackupsOf(dbPath: string): string[] {
  const prefix = `${basename(dbPath)}.pre-schema-`;
  try {
    return readdirSync(dirname(dbPath))
      .filter((name) => name.startsWith(prefix) && /^(?:\d+|retired|upgrade)\.bak(?:\.\d+\.partial)?$/.test(name.slice(prefix.length)))
      .map((name) => join(dirname(dbPath), name));
  } catch {
    return [];
  }
}

/** `setAside`: a file a failed update made, kept until the next commit and never put back over a store. */
interface SchemaBackupEntry { storeId: string; dbPath: string; backupPath: string; setAside?: boolean }

/**
 * The recorded copies. `owned` (the restore and the commit) keeps only the
 * product's own copies inside the live data root; a forget and the record's
 * own upkeep see every line, since a forget must reach every copy of its rows.
 */
function schemaBackups(env: LayoutEnv, owned = true): SchemaBackupEntry[] {
  let text: string;
  try {
    text = readFileSync(sharedDataPath('schema-backups', env), 'utf8');
  } catch {
    return [];
  }
  const entries = new Map<string, SchemaBackupEntry>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Partial<SchemaBackupEntry>;
      if (typeof entry.storeId === 'string' && typeof entry.dbPath === 'string' && typeof entry.backupPath === 'string'
        && (!owned || ownedBackup(entry.dbPath, entry.backupPath))) {
        entries.set(entry.backupPath, entry as SchemaBackupEntry);
      }
    } catch {
      // A torn last line from a crash: skip it.
    }
  }
  return [...entries.values()];
}

/** The product's own names for a copy: `<store>.pre-schema-<n|retired|upgrade>.bak`. */
const BACKUP_NAME = /\.pre-schema-(?:\d+|retired|upgrade)\.bak$/;

/**
 * Whether a recorded copy is one this product made: named exactly its store
 * plus a copy suffix, beside that store with no link in between, and itself
 * a file or folder, not a link. Records are written only as a copy is taken,
 * naming the live store's own path, so a whole-root backup an owner keeps
 * beside the root is never named; a line naming anything else is ignored by
 * the restore and the commit. Stores outside the data root (a legacy WhatsApp
 * store, a relocated Telegram one) are copies like any other.
 */
function ownedBackup(dbPath: string, backupPath: string): boolean {
  if (!ownedBackupName(dbPath, backupPath)) return false;
  try {
    const stat = lstatSync(backupPath);
    return !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory());
  } catch {
    // Gone already: nothing to restore or remove, and the record keeps the line for a forget.
    return false;
  }
}

/** The name and place half of ownedBackup: a copy's own name, beside its store, no link in between. */
function ownedBackupName(dbPath: string, backupPath: string): boolean {
  if (!isAbsolute(dbPath) || !isAbsolute(backupPath) || !backupPath.startsWith(dbPath)) return false;
  const suffix = backupPath.slice(dbPath.length);
  if (BACKUP_NAME.exec(suffix)?.[0] !== suffix) return false;
  try {
    return realpathSync(dirname(backupPath)) === resolve(dirname(backupPath));
  } catch {
    return false;
  }
}

/**
 * Removes every recorded backup, whenever it was taken: the committed
 * upgrade's own and any an earlier version left, since nothing restores them.
 */
export function removeRecordedSchemaBackups(env: LayoutEnv): number {
  const removed = schemaBackups(env).filter((entry) => copyOrPartLeft(entry.backupPath));
  for (const entry of removed) removeCopy(entry.backupPath);
  removeAbandonedCopiesOfRecorded(env);
  pruneSchemaBackupRecord(env);
  return removed.length;
}

function removeAbandonedCopiesOfRecorded(env: LayoutEnv): void {
  // A killed copy's partial outlives its copy, so only the name and place are checked here.
  const named = schemaBackups(env, false).filter((entry) => ownedBackupName(entry.dbPath, entry.backupPath));
  for (const backup of new Set(named.map((entry) => entry.backupPath))) removeAbandonedBackupCopies(backup);
}

/**
 * Every copy of every recorded store, part-way copies included: a forget's,
 * since each copy of a shared store still holds the forgotten rows. Returns
 * how many there are; a dry run removes nothing.
 */
export function removeAllSchemaBackups(env: LayoutEnv, dryRun: boolean): number {
  const recorded = schemaBackups(env, false);
  const copies = [...new Set([
    ...recorded.flatMap((entry) => preSchemaBackupsOf(entry.dbPath)),
    // A set-aside store's companions, its base already gone.
    ...recorded.filter((entry) => entry.setAside === true && copyOrPartLeft(entry.backupPath)).map((entry) => entry.backupPath),
  ])];
  if (dryRun) return copies.length;
  for (const copy of copies) removeCopy(copy);
  pruneSchemaBackupRecord(env);
  return copies.length;
}

/** A copy, with the -wal, -shm and -journal a set-aside store keeps under its name. */
function removeCopy(path: string): void {
  // The companions first: one cut short leaves the base, which the record still names, never an orphan -wal.
  for (const suffix of COMPANIONS) rmSync(`${path}${suffix}`, { force: true });
  rmSync(path, { recursive: true, force: true });
}

function copyOrPartLeft(path: string): boolean {
  return existsSync(path) || COMPANIONS.some((suffix) => existsSync(`${path}${suffix}`));
}

function pruneSchemaBackupRecord(env: LayoutEnv): void {
  const path = sharedDataPath('schema-backups', env);
  if (!existsSync(path)) return;
  const kept = schemaBackups(env, false).filter((entry) => copyOrPartLeft(entry.backupPath));
  if (kept.length === 0) rmSync(path, { force: true });
  else writePrivateFileAtomicSync(path, kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}
