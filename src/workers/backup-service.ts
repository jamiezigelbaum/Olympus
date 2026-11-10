/**
 * Settings › Back up and restore, the engine's half (#1065).
 *
 * Holds the owner's backup choices (folder, when), the key a passphrase was
 * turned into, the last backup's result, and runs backups: on Back up now and
 * when the schedule says one is due. Restore from the dashboard opens the
 * backup into private staging while the worker runs (a wrong passphrase or a
 * changed file is refused there, with nothing written), then asks the worker
 * to restart; the restore itself runs at the next start, under the data owner
 * lock and before anything opens a store (`applyPendingRestoreAtBoot`), and
 * its result is what the page shows when the worker answers again.
 *
 * The passphrase is never stored. Scheduled backups need a key, so the key
 * derived from the passphrase (scrypt, with the salt every backup's header
 * names) is kept in an owner-only file under the owner config folder: anyone
 * who can read that file can open these backups, which is why the page says
 * it is kept on this computer.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { removeFileDurablySync, writePrivateFileAtomicSync } from '../core/atomic-file.ts';
import { OperationError } from '../core/operation-error.ts';
import { defaultOwnerConfigPath } from '../core/owner-config-read.ts';
import { sharedDataPath } from '../core/olympus-layout.ts';
import {
  BACKUP_KEEP,
  backupKeyCheck,
  backupOlympusData,
  backupStagingDir,
  checkKdf,
  deriveBackupKey,
  listBackups,
  openBackupFile,
  type BackupFileInfo,
  type BackupKdf,
  type BackupKey,
} from '../data-backup.ts';
import { restoreOlympusData } from '../data-restore.ts';
import { realPathOfScopePath } from './local-files/locations.ts';
import { normalizeScopePath } from './local-files/paths.ts';
import { VolumeResolver } from './local-files/volume-identity.ts';

export type BackupSchedule = 'manual' | 'nightly' | 'weekly';
export const BACKUP_SCHEDULES: readonly BackupSchedule[] = ['manual', 'nightly', 'weekly'];
/** Scheduled backups start at or after this local hour. */
export const BACKUP_HOUR = 3;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

const SETTINGS_SCHEMA = 'olympus.backup.settings.v1';
const KEY_SCHEMA = 'olympus.backup.key.v1';
const PENDING_RESTORE = 'pending-restore.json';
const RESTORE_RESULT = 'restore-result.json';

export interface BackupSettingsFile {
  schema: typeof SETTINGS_SCHEMA;
  folder?: string;
  /**
   * The folder as the picker named it: bound to its disk's identity, so a
   * backup is written only when that same disk is connected, wherever it is
   * mounted, and never onto another disk now mounted at the same place.
   */
  folder_key?: string;
  schedule: BackupSchedule;
  /** The last finished backup. */
  last?: { at: string; file: string; bytes: number; encrypted: boolean };
  /** When a backup last started, scheduled or not (what the schedule counts from). */
  last_attempt_at?: string;
  /** The last backup that failed, and why, until one succeeds. */
  last_error?: { at: string; message: string };
}

export interface BackupRestoreState {
  state: 'restarting' | 'done' | 'failed';
  at: string;
  /** done: the sources to sign in to again. */
  sign_in_again?: string[];
  notes?: string[];
  /** failed: why. */
  message?: string;
}

/** What Settings shows. Paths are the owner's own folder, shown only to the unlocked local session. */
export interface BackupStatus {
  folder?: string;
  schedule: BackupSchedule;
  passphraseSet: boolean;
  /** A passphrase was set but its kept key can't be used: backups fail until it is set again. */
  passphraseProblem?: boolean;
  last?: { at: string; file: string; bytes: number; encrypted: boolean };
  lastError?: { at: string; message: string };
  running: boolean;
  /** The backups in the folder, newest first. */
  backups: BackupFileInfo[];
  restore?: BackupRestoreState;
  /** False where the worker cannot restart itself, so Restore must run from the command line. */
  restoreAvailable: boolean;
}

export interface BackupServicePaths {
  settings: string;
  key: string;
  /** The data root's backup staging folder. */
  staging: string;
}

export function defaultBackupServicePaths(env: Record<string, string | undefined> = process.env): BackupServicePaths {
  return {
    settings: defaultOwnerConfigPath('backup.json', env),
    key: defaultOwnerConfigPath('backup-key.json', env),
    staging: sharedDataPath('backup-staging', env),
  };
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readBackupSettings(path: string): BackupSettingsFile {
  const raw = readJson(path) as Partial<BackupSettingsFile> | undefined;
  if (!raw || raw.schema !== SETTINGS_SCHEMA) return { schema: SETTINGS_SCHEMA, schedule: 'manual' };
  return {
    schema: SETTINGS_SCHEMA,
    ...(typeof raw.folder === 'string' && raw.folder.startsWith('/') ? { folder: raw.folder } : {}),
    ...(typeof raw.folder_key === 'string' && raw.folder_key.startsWith('/') ? { folder_key: raw.folder_key } : {}),
    schedule: BACKUP_SCHEDULES.includes(raw.schedule as BackupSchedule) ? raw.schedule as BackupSchedule : 'manual',
    ...(raw.last && typeof raw.last.at === 'string' ? { last: raw.last } : {}),
    ...(typeof raw.last_attempt_at === 'string' ? { last_attempt_at: raw.last_attempt_at } : {}),
    ...(raw.last_error && typeof raw.last_error.at === 'string' ? { last_error: raw.last_error } : {}),
  };
}

/** Said when the backup folder's disk is missing or another disk is in its place: nothing is written or removed. */
export const BACKUP_DISK_ABSENT = 'The disk with your backup folder isn\'t connected (or another disk is in its place), so no backup was made and no older backup was removed. Connect it, or choose the folder again.';

/** Said when a passphrase was set but its key can't be used: no backup is made without it. */
export const BACKUP_KEY_INVALID = 'The key kept for your passphrase can\'t be read, so no backup was made. Set the passphrase again (or choose to back up without one).';

/**
 * The stored key: `absent` only when no key file exists (no passphrase was
 * set). A file that exists but cannot be read, is malformed, or fails its
 * key check is `invalid`, and a backup then fails closed: it is never
 * written unencrypted in its place.
 */
export function readStoredBackupKeyState(path: string): { state: 'absent' } | { state: 'ok'; key: BackupKey } | { state: 'invalid' } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'invalid' };
  }
  try {
    const raw = JSON.parse(text) as { schema?: string; kdf?: BackupKdf; key?: string; key_check?: string };
    if (!raw || raw.schema !== KEY_SCHEMA || !raw.kdf || typeof raw.kdf.salt !== 'string' || typeof raw.key !== 'string' || typeof raw.key_check !== 'string') return { state: 'invalid' };
    const key = Buffer.from(raw.key, 'base64');
    if (key.length !== 32 || backupKeyCheck(key) !== raw.key_check) return { state: 'invalid' };
    // Its key setting too: backups written under a setting no restore accepts could never be opened.
    checkKdf(raw.kdf);
    return { state: 'ok', key: { key, kdf: raw.kdf } };
  } catch {
    return { state: 'invalid' };
  }
}

/** The stored key when it is usable; undefined when absent or invalid. */
export function readStoredBackupKey(path: string): BackupKey | undefined {
  const stored = readStoredBackupKeyState(path);
  return stored.state === 'ok' ? stored.key : undefined;
}

/**
 * Whether a scheduled backup is due: nightly, once each day at or after 03:00
 * local time; weekly, once seven days have passed since the last one started
 * (also at or after 03:00). A failure is tried again an hour later.
 */
export function backupDue(settings: BackupSettingsFile, now: Date): boolean {
  if (!settings.folder || settings.schedule === 'manual') return false;
  if (now.getHours() < BACKUP_HOUR) return false;
  const lastAttempt = settings.last_attempt_at ? new Date(settings.last_attempt_at) : undefined;
  if (!lastAttempt || Number.isNaN(lastAttempt.getTime())) return true;
  const lastFailed = settings.last_error !== undefined && settings.last_error.at >= (settings.last?.at ?? '');
  if (lastFailed) return now.getTime() - lastAttempt.getTime() >= RETRY_AFTER_FAILURE_MS;
  const todayAtHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), BACKUP_HOUR);
  if (settings.schedule === 'nightly') return lastAttempt.getTime() < todayAtHour.getTime();
  const weekBefore = new Date(todayAtHour);
  weekBefore.setDate(weekBefore.getDate() - 6);
  return lastAttempt.getTime() < weekBefore.getTime();
}

export interface BackupServiceOptions {
  paths: BackupServicePaths;
  /** Write a version-3 export into `destination` (the worker, as data owner). */
  exportInto: (destination: string) => unknown | Promise<unknown>;
  /** Ask the worker to restart; false where it cannot restart itself. */
  requestRestart: () => boolean;
  /** Whether the worker can restart itself at all. */
  canRestart: () => boolean;
  /** The data owner's context for staging (env). */
  env: Record<string, string | undefined>;
  now?: () => Date;
  keep?: number;
  /** Where a folder key points now; undefined when its disk is not connected. Default: the disks mounted now. */
  resolveFolderKey?: (key: string) => string | undefined;
}

export interface BackupService {
  status(): BackupStatus;
  saveSettings(input: { folder?: string; folderKey?: string; schedule?: BackupSchedule }): BackupStatus;
  setPassphrase(passphrase: string | null): BackupStatus;
  /** Start a backup now; resolves when it has finished (callers may not wait). */
  runNow(): Promise<BackupStatus>;
  /** Called by the scheduler: runs a backup when one is due. */
  tick(): Promise<boolean>;
  /** Open the backup, check it fits this install, then restart to restore it. */
  restore(input: { file: string; passphrase?: string }): BackupStatus;
}

export function createBackupService(options: BackupServiceOptions): BackupService {
  const now = options.now ?? (() => new Date());
  let running: Promise<BackupStatus> | undefined;
  let restoreState: BackupRestoreState | undefined;
  const settings = () => readBackupSettings(options.paths.settings);
  const resolveFolderKey = options.resolveFolderKey ?? ((key: string) => {
    try { return realPathOfScopePath(new VolumeResolver(), normalizeScopePath(key)); } catch { return undefined; }
  });
  /** The folder backups go to now: the chosen disk's folder, or undefined when that disk is not connected. */
  const folderNow = (current: BackupSettingsFile): string | undefined => {
    if (!current.folder) return undefined;
    return current.folder_key ? resolveFolderKey(current.folder_key) : current.folder;
  };
  const save = (next: BackupSettingsFile) => writePrivateJson(options.paths.settings, next);

  const status = (): BackupStatus => {
    const current = settings();
    const fromBoot = readJson(join(options.paths.staging, RESTORE_RESULT)) as BackupRestoreState | undefined;
    // What the restart reported wins: it is newer than anything this process asked for.
    const restore = (fromBoot && typeof fromBoot.state === 'string' ? fromBoot : undefined) ?? restoreState;
    return {
      ...(current.folder ? { folder: current.folder } : {}),
      schedule: current.schedule,
      ...(() => {
        const stored = readStoredBackupKeyState(options.paths.key).state;
        return { passphraseSet: stored !== 'absent', ...(stored === 'invalid' ? { passphraseProblem: true } : {}) };
      })(),
      ...(current.last ? { last: current.last } : {}),
      ...(current.last_error && current.last_error.at >= (current.last?.at ?? '') ? { lastError: current.last_error } : {}),
      running: running !== undefined,
      backups: (() => { const folder = folderNow(current); return folder ? listBackups(folder) : []; })(),
      ...(restore ? { restore } : {}),
      restoreAvailable: options.canRestart(),
    };
  };

  const run = async (): Promise<BackupStatus> => {
    const current = settings();
    if (!current.folder) throw new OperationError('invalid_params', 'Choose a folder for backups first.');
    const startedAt = now();
    save({ ...current, last_attempt_at: startedAt.toISOString() });
    try {
      const stored = readStoredBackupKeyState(options.paths.key);
      // Fail closed: a passphrase was set, so never write this backup unencrypted.
      if (stored.state === 'invalid') throw new OperationError('invalid_params', BACKUP_KEY_INVALID);
      const key = stored.state === 'ok' ? stored.key : undefined;
      // The chosen disk, asked again before writing and again before older backups are removed.
      const folder = folderNow(current);
      if (!folder) throw new OperationError('invalid_params', BACKUP_DISK_ABSENT);
      // The export can take a while: the disk can go, or be replaced, in that time.
      const sameDisk = () => {
        if (folderNow(settings()) !== folder) throw new OperationError('invalid_params', BACKUP_DISK_ABSENT);
      };
      const result = await backupOlympusData({
        folder,
        beforeWrite: sameDisk,
        beforePrune: sameDisk,
        ...(key ? { key } : {}),
        now: startedAt,
        keep: options.keep ?? BACKUP_KEEP,
        env: options.env,
        exportInto: options.exportInto,
      });
      const after = settings();
      const { last_error: _cleared, ...rest } = after;
      save({ ...rest, last: { at: result.createdAt, file: result.file, bytes: result.bytes, encrypted: result.encrypted } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The backup did not finish.';
      save({ ...settings(), last_error: { at: now().toISOString(), message } });
    }
    return status();
  };

  const runNow = (): Promise<BackupStatus> => {
    if (!running) {
      if (!settings().folder) throw new OperationError('invalid_params', 'Choose a folder for backups first.');
      running = run().finally(() => { running = undefined; });
    }
    return running;
  };

  return {
    status,
    saveSettings(input) {
      const current = settings();
      const next: BackupSettingsFile = { ...current };
      if (input.folder !== undefined) {
        next.folder = input.folder;
        if (input.folderKey !== undefined) next.folder_key = input.folderKey;
        else delete next.folder_key;
        // A folder chosen for the first time backs up every night unless the owner says otherwise.
        if (!current.folder && input.schedule === undefined) next.schedule = 'nightly';
      }
      if (input.schedule !== undefined) {
        if (!BACKUP_SCHEDULES.includes(input.schedule)) throw new OperationError('invalid_params', 'Choose when to back up.');
        next.schedule = input.schedule;
      }
      save(next);
      return status();
    },
    setPassphrase(passphrase) {
      if (passphrase === null) {
        removeFileDurablySync(options.paths.key);
        return status();
      }
      if (passphrase.trim().length < 8) throw new OperationError('invalid_params', 'Use a passphrase of at least 8 characters.');
      const derived = deriveBackupKey(passphrase);
      writePrivateJson(options.paths.key, { schema: KEY_SCHEMA, kdf: derived.kdf, key: derived.key.toString('base64'), key_check: backupKeyCheck(derived.key) });
      return status();
    },
    runNow,
    async tick() {
      if (running || !backupDue(settings(), now())) return false;
      await runNow();
      return true;
    },
    restore(input) {
      if (!options.canRestart()) {
        throw new OperationError('invalid_params', 'Olympus can\'t restart itself here, so restore from the command line with Olympus stopped.', 'olympus data restore --input <file> --passphrase-stdin');
      }
      let file: string;
      try { file = input.file; if (!statSync(file).isFile()) throw new Error('not a file'); } catch {
        throw new OperationError('invalid_params', 'That backup file is no longer there. Choose it again.');
      }
      // A restore is already waiting for the restart: one is enough.
      if (existsSync(join(options.paths.staging, PENDING_RESTORE))) return status();
      const staging = backupStagingDir(options.env);
      try {
        const opened = openBackupFile({
          file,
          into: staging,
          ...(input.passphrase ? { passphrase: input.passphrase } : {}),
          ...(readStoredBackupKey(options.paths.key) ? { key: readStoredBackupKey(options.paths.key)! } : {}),
        });
        // Everything that would refuse at the restart refuses now, before anything stops.
        restoreOlympusData({ input: opened.exportDir, dryRun: true, env: options.env });
        rmSync(join(options.paths.staging, RESTORE_RESULT), { force: true });
        writePrivateJson(join(options.paths.staging, PENDING_RESTORE), { export_dir: opened.exportDir, staging, requested_at: now().toISOString() });
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
      restoreState = { state: 'restarting', at: now().toISOString() };
      if (!options.requestRestart()) {
        removeFileDurablySync(join(options.paths.staging, PENDING_RESTORE));
        rmSync(staging, { recursive: true, force: true });
        restoreState = undefined;
        throw new OperationError('invalid_params', 'Olympus could not restart to restore. Restore from the command line with Olympus stopped.');
      }
      return status();
    },
  };
}

/**
 * At worker start, under the data owner lock and before anything opens a
 * store: run a restore the dashboard asked for, record what came of it for
 * the page, and remove the opened backup. Also clears staging folders an
 * earlier backup or restore left behind (a crash part way).
 */
export function applyPendingRestoreAtBoot(paths: Pick<BackupServicePaths, 'staging'>, env: Record<string, string | undefined>, at: () => Date = () => new Date()): BackupRestoreState | undefined {
  const pendingPath = join(paths.staging, PENDING_RESTORE);
  const pending = readJson(pendingPath) as { export_dir?: string; staging?: string } | undefined;
  let result: BackupRestoreState | undefined;
  if (pending) {
    try {
      if (typeof pending.export_dir !== 'string' || !pending.export_dir.startsWith(paths.staging + '/')) throw new Error('The restore that was asked for is incomplete. Choose the backup again.');
      const restored = restoreOlympusData({ input: pending.export_dir, env });
      result = { state: 'done', at: at().toISOString(), sign_in_again: restored.signInAgain, notes: restored.notes };
      console.log(`[backup] Restored ${restored.sourceIds.length} source(s) from a backup.`);
    } catch (error) {
      result = { state: 'failed', at: at().toISOString(), message: error instanceof Error ? error.message : 'The restore did not finish.' };
      console.warn(`[backup] The restore did not finish: ${result.message}`);
    }
    writePrivateJson(join(paths.staging, RESTORE_RESULT), result);
    removeFileDurablySync(pendingPath);
  }
  // Nothing else in staging outlives a start: an export or an opened backup left by a crash.
  try {
    for (const name of readdirSync(paths.staging)) {
      if (name === RESTORE_RESULT) continue;
      rmSync(join(paths.staging, name), { recursive: true, force: true });
    }
  } catch { /* no staging folder yet */ }
  return result;
}
