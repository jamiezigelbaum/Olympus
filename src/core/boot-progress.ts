// What the worker is doing while it boots, for the waits that would otherwise
// give up at a fixed ceiling (#1494): the upgrade's readiness probe, the
// engine host's startup wait, and the split's front. An upgrade from 1.4.4
// spent minutes per tier ledger in schema updates and was rolled back while
// it was still working.
//
// The file holds store ids and counts only, never a path, a source name or
// item content. The worker (single, or the split's background) writes it; the
// front never does, since it does not own the data root.
//
// The store backups each schema update takes are recorded beside it, so a
// failed upgrade can put them back before the previous version starts.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { sharedDataPath, type LayoutEnv } from './olympus-layout.ts';

export const BOOT_PROGRESS_SCHEMA = 'olympus.boot-progress.v1';

export type BootPhase = 'starting' | 'backing_up' | 'migrating' | 'done';

export interface BootProgress {
  schema: typeof BOOT_PROGRESS_SCHEMA;
  pid: number;
  phase: BootPhase;
  storeId?: string;
  startedAt: string;
  updatedAt: string;
  completedStores: number;
}

export interface BootStepEvent {
  phase: BootPhase;
  storeId?: string;
  /** A store finished its schema update. */
  completedStore?: boolean;
}

/** One long step (a backup, one store's update) can't heartbeat: past this it is hung. */
export const BOOT_LONG_STEP_BACKSTOP_MS = 6 * 60 * 60 * 1000;
/** A boot that has not reported anything for this long has stalled. */
export const BOOT_STALL_MS = 5 * 60 * 1000;
const WRITE_INTERVAL_MS = 1_000;

// This process's boot: reports count only between beginBootProgress and
// finishBootProgress, so a CLI command or a store opened after boot never
// writes over the worker's file.
let current: { env: LayoutEnv; progress: BootProgress; lastWriteMs: number } | undefined;

/** The worker's boot starts: called once it holds the data-owner lock. */
export function beginBootProgress(env: LayoutEnv = process.env, now: () => number = Date.now): void {
  const at = new Date(now()).toISOString();
  current = {
    env,
    progress: { schema: BOOT_PROGRESS_SCHEMA, pid: process.pid, phase: 'starting', startedAt: at, updatedAt: at, completedStores: 0 },
    lastWriteMs: 0,
  };
  write(now(), true);
}

/** The worker's boot work is done (it listens, or the background is ready). */
export function finishBootProgress(now: () => number = Date.now): void {
  if (!current) return;
  current.progress = { ...current.progress, phase: 'done', updatedAt: new Date(now()).toISOString() };
  delete current.progress.storeId;
  write(now(), true);
  current = undefined;
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
    write(now(), phaseChanged);
  } catch {
    // Progress is advisory; the boot goes on.
  }
}

function write(nowMs: number, force: boolean): void {
  if (!current) return;
  if (!force && nowMs - current.lastWriteMs < WRITE_INTERVAL_MS) return;
  try {
    const path = bootProgressPath(current.env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(path, `${JSON.stringify(current.progress)}\n`);
    current.lastWriteMs = nowMs;
  } catch {
    // A full or read-only disk: the waits fall back to their ceilings.
  }
}

export function readBootProgress(env: LayoutEnv = process.env): BootProgress | undefined {
  try {
    const value = JSON.parse(readFileSync(bootProgressPath(env), 'utf8')) as Partial<BootProgress>;
    if (value.schema !== BOOT_PROGRESS_SCHEMA || typeof value.pid !== 'number' || typeof value.phase !== 'string'
      || typeof value.startedAt !== 'string' || typeof value.updatedAt !== 'string') return undefined;
    return { completedStores: 0, ...value } as BootProgress;
  } catch {
    return undefined;
  }
}

/**
 * Whether a worker is still doing boot work: not done, its process alive, and
 * either in one long step (a backup or a store update) started less than six
 * hours ago, or starting with a report in the last five minutes.
 */
export function bootInProgress(env: LayoutEnv = process.env, now: number = Date.now()): boolean {
  return bootProgressIsLive(readBootProgress(env), now);
}

export function bootProgressIsLive(
  progress: BootProgress | undefined,
  now: number = Date.now(),
  alive: (pid: number) => boolean = processAlive,
): boolean {
  if (!progress || progress.phase === 'done' || !alive(progress.pid)) return false;
  if (progress.phase === 'backing_up' || progress.phase === 'migrating') {
    return now - Date.parse(progress.startedAt) < BOOT_LONG_STEP_BACKSTOP_MS;
  }
  return now - Date.parse(progress.updatedAt) < BOOT_STALL_MS;
}

/** One line for a person waiting: "Updating your data: N stores done, now <storeId> (Xm)". */
export function bootProgressLine(progress: BootProgress, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(progress.startedAt)) / 60_000));
  const store = progress.storeId ? `, now ${progress.storeId}` : '';
  return `Updating your data: ${progress.completedStores} ${progress.completedStores === 1 ? 'store' : 'stores'} done${store} (${minutes}m)`;
}

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

/** `<db file>.pre-schema-<version>.bak`: a store as it was before its schema update. */
export function preSchemaBackupPath(dbPath: string, version: number): string {
  return `${dbPath}.pre-schema-${version}.bak`;
}

/** Every pre-update copy of the store at `dbPath` on disk, a copy a crash left part way included. */
export function preSchemaBackupsOf(dbPath: string): string[] {
  const prefix = `${basename(dbPath)}.pre-schema-`;
  try {
    return readdirSync(dirname(dbPath))
      .filter((name) => name.startsWith(prefix) && /^\d+\.bak(?:\.\d+\.partial)?$/.test(name.slice(prefix.length)))
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

function schemaBackups(env: LayoutEnv): SchemaBackupEntry[] {
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
      if (typeof entry.storeId === 'string' && typeof entry.dbPath === 'string' && typeof entry.backupPath === 'string') {
        entries.set(entry.backupPath, entry as SchemaBackupEntry);
      }
    } catch {
      // A torn last line from a crash: skip it.
    }
  }
  return [...entries.values()];
}

function backupsSince(env: LayoutEnv, sinceMs: number): SchemaBackupEntry[] {
  return schemaBackups(env).filter((entry) => {
    try {
      return statSync(entry.backupPath).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  });
}

/**
 * Puts back every store backed up at or after `sinceMs`: the backup replaces
 * its database, and the database's -wal and -shm go. Returns the store ids
 * restored. The worker must be stopped first.
 */
export function restoreSchemaBackupsSince(env: LayoutEnv, sinceMs: number): string[] {
  const restored: string[] = [];
  for (const entry of backupsSince(env, sinceMs)) {
    rmSync(`${entry.dbPath}-wal`, { force: true });
    rmSync(`${entry.dbPath}-shm`, { force: true });
    renameSync(entry.backupPath, entry.dbPath);
    restored.push(entry.storeId);
  }
  pruneSchemaBackupRecord(env);
  return restored;
}

/** Removes the backups taken at or after `sinceMs`: the update they guarded succeeded. */
export function removeSchemaBackupsSince(env: LayoutEnv, sinceMs: number): number {
  const removed = backupsSince(env, sinceMs);
  for (const entry of removed) rmSync(entry.backupPath, { force: true });
  pruneSchemaBackupRecord(env);
  return removed.length;
}

/**
 * Every copy of every recorded store, part-way copies included: a forget's,
 * since each copy of a shared store still holds the forgotten rows. Returns
 * how many there are; a dry run removes nothing.
 */
export function removeAllSchemaBackups(env: LayoutEnv, dryRun: boolean): number {
  const copies = [...new Set(schemaBackups(env).flatMap((entry) => preSchemaBackupsOf(entry.dbPath)))];
  if (dryRun) return copies.length;
  for (const copy of copies) rmSync(copy, { force: true });
  pruneSchemaBackupRecord(env);
  return copies.length;
}

function pruneSchemaBackupRecord(env: LayoutEnv): void {
  const path = sharedDataPath('schema-backups', env);
  if (!existsSync(path)) return;
  const kept = schemaBackups(env).filter((entry) => existsSync(entry.backupPath));
  if (kept.length === 0) rmSync(path, { force: true });
  else writePrivateFileAtomicSync(path, kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}
