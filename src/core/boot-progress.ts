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

import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<BootProgress>;
    if (value.schema !== BOOT_PROGRESS_SCHEMA || typeof value.pid !== 'number' || typeof value.phase !== 'string'
      || typeof value.startedAt !== 'string' || typeof value.updatedAt !== 'string') return undefined;
    if (value.failures !== undefined && (!Number.isSafeInteger(value.failures) || value.failures < 0)) delete value.failures;
    if (value.lastFailure !== undefined && typeof value.lastFailure !== 'string') delete value.lastFailure;
    return { completedStores: 0, ...value } as BootProgress;
  } catch {
    return undefined;
  }
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

/** The copy `olympus worker upgrade` takes of each store before the new version starts (upgrade-store-copies.ts). */
export const UPGRADE_COPY_SUFFIX = '.pre-schema-upgrade.bak';

/**
 * Whether a worker upgrade is in flight: `olympus worker upgrade` marks it
 * before it copies the stores and clears it when it commits or rolls back.
 * Only then can a copy the boot takes be put back by anything; otherwise (the
 * upgrade committed, or the version came by another way) a boot copy is never
 * restored and never removed (rc.13's success leg: stores the engine first
 * opened after the commit each left a backup). So the boot copies, and moves
 * retired state aside, only while one is in flight.
 */
export function workerUpgradeInFlight(env: LayoutEnv): boolean {
  return existsSync(sharedDataPath('upgrade-in-flight', env));
}

/** Folders under the data root that hold no store: model files and a backup being packed. */
const STORELESS_FOLDERS = new Set(['models', 'backup-staging']);

/** Every file under the data root whose name `keep` accepts, links and the store-less folders left out. */
export function dataRootFiles(env: LayoutEnv, keep: (name: string) => boolean): string[] {
  const files: string[] = [];
  const walk = (directory: string, top: boolean) => {
    let names: string[];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
      if (top && STORELESS_FOLDERS.has(name)) continue;
      const path = join(directory, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isDirectory()) walk(path, false);
      else if (stat.isFile() && keep(name)) files.push(path);
    }
  };
  walk(olympusDataRoot(env), true);
  return files.sort();
}

/** The files a version keeps state in: stores, lock databases and ledgers. The record of copies is the put-back's own. */
function stateFiles(env: LayoutEnv): string[] {
  const record = basename(sharedDataPath('schema-backups', env));
  return dataRootFiles(env, (name) => /\.(sqlite|db|jsonl)$/.test(name) && name !== record);
}

/**
 * Marks an upgrade in flight, with the engine stopped. The mark lists the state files there are now, so a put-back
 * also takes away the ones the new version made: on the Mac forced-failure leg (run 43751182260, 15 Nov 2026) the new
 * version went on with an mbox import and made its archive store at its own schema, which the restored 1.4.4 refused.
 */
export function markWorkerUpgradeInFlight(env: LayoutEnv, startedAt: string): void {
  const path = sharedDataPath('upgrade-in-flight', env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const root = olympusDataRoot(env);
  const stateNow = stateFiles(env).map((file) => relative(root, file));
  writePrivateFileAtomicSync(path, `${JSON.stringify({ started_at: startedAt, state_files: stateNow })}\n`);
}

/** `<path>.pre-schema-failed.bak`: a state file a failed update made, set aside by its put-back until the next committed upgrade. */
export function failedUpdateSetAsidePath(path: string): string {
  return `${path}.pre-schema-failed.bak`;
}

const COMPANIONS = ['-wal', '-shm', '-journal'] as const;

/**
 * Sets aside the state files made since the mark, each with its -wal, -shm and -journal under the same new name, and
 * records them with the copies: a forget reaches them, and the next committed upgrade removes them with the copies.
 * Never deleted here, since they can hold what the owner imported while the update ran. None when the mark has no list.
 */
function setAsideStateFilesMadeSinceMark(env: LayoutEnv, putBack: ReadonlySet<string>): string[] {
  let listed: unknown;
  try { listed = (JSON.parse(readFileSync(sharedDataPath('upgrade-in-flight', env), 'utf8')) as { state_files?: unknown }).state_files; } catch { return []; }
  if (!Array.isArray(listed)) return [];
  const before = new Set(listed.filter((entry): entry is string => typeof entry === 'string'));
  const root = olympusDataRoot(env);
  const setAside: string[] = [];
  for (const file of stateFiles(env)) {
    const id = relative(root, file);
    if (before.has(id) || putBack.has(file)) continue;
    const target = failedUpdateSetAsidePath(file);
    recordSchemaBackup(env, { storeId: id, dbPath: file, backupPath: target });
    for (const suffix of COMPANIONS) rmSync(`${target}${suffix}`, { force: true });
    renameSync(file, target);
    for (const suffix of COMPANIONS) if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${target}${suffix}`);
    setAside.push(id);
  }
  return setAside;
}

/**
 * When the upgrade in flight started: undefined when none is, '' when its
 * mark cannot be read (then nothing is put back: an earlier copy left on disk
 * would be older than the store).
 */
export function readWorkerUpgradeInFlight(env: LayoutEnv): string | undefined {
  try {
    const mark = JSON.parse(readFileSync(sharedDataPath('upgrade-in-flight', env), 'utf8')) as { started_at?: unknown };
    return typeof mark.started_at === 'string' && Number.isFinite(Date.parse(mark.started_at)) ? mark.started_at : '';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : '';
  }
}

export function clearWorkerUpgradeInFlight(env: LayoutEnv): void {
  rmSync(sharedDataPath('upgrade-in-flight', env), { force: true });
}

/** `<db file>.pre-schema-<version>.bak`: a store as it was before its schema update. */
export function preSchemaBackupPath(dbPath: string, version: number): string {
  return `${dbPath}.pre-schema-${version}.bak`;
}

/** `<path>.pre-schema-retired.bak`: retired state, moved aside rather than deleted, until the upgrade commits. */
export function retiredStateBackupPath(path: string): string {
  return `${path}.pre-schema-retired.bak`;
}

/**
 * Retires a file or folder an earlier version kept (the removed pre-filter's
 * ledger and weights, #1415): moved aside and recorded with the schema
 * backups, not deleted. A failed upgrade puts it back with the stores, a
 * committed one removes it with the other copies, and `delete --all` finds
 * it (#1563: rc.4 deleted the pre-filter ledger outright, so its rollback
 * came back with 7 of 8 ledgers). A database must be checkpointed first:
 * only the main file is kept. Returns whether anything was moved.
 */
export function retireStatePath(env: LayoutEnv, storeId: string, path: string): boolean {
  if (!existsSync(path)) return false;
  // No upgrade in flight to put it back: it goes now (workerUpgradeInFlight).
  if (!workerUpgradeInFlight(env)) {
    rmSync(path, { recursive: true, force: true });
    return true;
  }
  const backup = retiredStateBackupPath(path);
  // A copy an earlier start left is older than the state here, which a
  // version that still used it wrote since: the newer state is the one kept.
  rmSync(backup, { recursive: true, force: true });
  recordSchemaBackup(env, { storeId, dbPath: path, backupPath: backup });
  // The restore and the commit pick their copies by time, so the time is set
  // before the move, which keeps it: no moment where the copy is aside but
  // looks older than the upgrade (#1563 review).
  const now = new Date();
  utimesSync(path, now, now);
  renameSync(path, backup);
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
      .filter((name) => name.startsWith(prefix) && /^(?:\d+|retired|upgrade|failed)\.bak(?:\.\d+\.partial)?$/.test(name.slice(prefix.length)))
      .map((name) => join(dirname(dbPath), name));
  } catch {
    return [];
  }
}

/**
 * Records a backup taken before a schema update, so the upgrade that caused it
 * can put it back. One line per backup; a line is appended in one write.
 */
export function recordSchemaBackup(env: LayoutEnv, entry: { storeId: string; dbPath: string; backupPath: string }): void {
  const path = sharedDataPath('schema-backups', env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

interface SchemaBackupEntry { storeId: string; dbPath: string; backupPath: string }

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
const BACKUP_NAME = /\.pre-schema-(?:\d+|retired|upgrade|failed)\.bak$/;

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

function backupsSince(env: LayoutEnv, sinceMs: number): SchemaBackupEntry[] {
  return schemaBackups(env).filter((entry) => {
    // What a put-back set aside is never put back over a store.
    if (entry.backupPath === failedUpdateSetAsidePath(entry.dbPath)) return false;
    try {
      return statSync(entry.backupPath).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  });
}

/**
 * Puts back every store backed up at or after `sinceMs`: the backup replaces
 * its database, and the database's -wal, -shm and -journal go. A -journal
 * left by a process stopped inside a transaction belongs to the file being
 * replaced: SQLite would roll it back into the restored copy, which is not
 * the file it was written for. Returns the store ids restored. The worker
 * must be stopped first, so every part-way copy a stopped process left is
 * removed too (the gate7 forced leg, 2026-11-13, left both behind).
 */
export function restoreSchemaBackupsSince(env: LayoutEnv, sinceMs: number): string[] {
  const restored: string[] = [];
  // Two stores in one file each copy it before their update: the earliest
  // copy is the file as it was, and the later ones are dropped.
  const byFile = new Map<string, SchemaBackupEntry[]>();
  for (const entry of backupsSince(env, sinceMs)) byFile.set(entry.dbPath, [...(byFile.get(entry.dbPath) ?? []), entry]);
  for (const [dbPath, entries] of byFile) {
    const [earliest, ...later] = entries.sort((a, b) => statSync(a.backupPath).mtimeMs - statSync(b.backupPath).mtimeMs);
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${dbPath}${suffix}`, { force: true });
    renameSync(earliest!.backupPath, dbPath);
    for (const entry of later) rmSync(entry.backupPath, { recursive: true, force: true });
    restored.push(...entries.map((entry) => entry.storeId));
  }
  // What the new version made did not exist before it: the earlier version would open it at a schema it does not know.
  for (const id of setAsideStateFilesMadeSinceMark(env, new Set(byFile.keys()))) restored.push(`${id} (made by the update, set aside)`);
  removeAbandonedCopiesOfRecorded(env);
  pruneSchemaBackupRecord(env);
  return restored;
}

/**
 * Removes every recorded backup, whenever it was taken: the committed
 * upgrade's own and any an earlier version left, since nothing restores them.
 */
export function removeRecordedSchemaBackups(env: LayoutEnv): number {
  const removed = schemaBackups(env).filter((entry) => existsSync(entry.backupPath));
  for (const entry of removed) removeCopy(entry.backupPath);
  removeAbandonedCopiesOfRecorded(env);
  pruneSchemaBackupRecord(env);
  return removed.length;
}

/** Removes the backups taken at or after `sinceMs`: the update they guarded succeeded. */
export function removeSchemaBackupsSince(env: LayoutEnv, sinceMs: number): number {
  const removed = backupsSince(env, sinceMs);
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
  const copies = [...new Set(schemaBackups(env, false).flatMap((entry) => preSchemaBackupsOf(entry.dbPath)))];
  if (dryRun) return copies.length;
  for (const copy of copies) removeCopy(copy);
  pruneSchemaBackupRecord(env);
  return copies.length;
}

/** A copy, with the -wal, -shm and -journal a set-aside store keeps under its name. */
function removeCopy(path: string): void {
  rmSync(path, { recursive: true, force: true });
  for (const suffix of COMPANIONS) rmSync(`${path}${suffix}`, { force: true });
}

function pruneSchemaBackupRecord(env: LayoutEnv): void {
  const path = sharedDataPath('schema-backups', env);
  if (!existsSync(path)) return;
  const kept = schemaBackups(env, false).filter((entry) => existsSync(entry.backupPath));
  if (kept.length === 0) rmSync(path, { force: true });
  else writePrivateFileAtomicSync(path, kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}
