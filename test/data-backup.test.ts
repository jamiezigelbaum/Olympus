// Backups (#1065): one file, packed and (with a passphrase) encrypted, that
// restores onto a fresh install; a wrong passphrase or a changed byte
// restores nothing; a backup folder keeps the newest seven.
import { lifecycleViews } from './helpers/lifecycle-view.ts';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { exportOlympusData, lifecycleEnv } from '../src/data-lifecycle.ts';
import {
  BACKUP_CHANGED,
  BACKUP_WRONG_PASSPHRASE,
  backupOlympusData,
  backupFileName,
  deriveBackupKey,
  listBackups,
  pruneBackups,
  readBackupHeader,
  restoreOlympusBackup,
  writeBackupFile,
  USTAR_MAX_SIZE,
} from '../src/data-backup.ts';
import { sharedDataPath } from '../src/core/olympus-layout.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';

function seed(path: string, table: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT NOT NULL);`);
  db.query(`INSERT INTO ${table} (value) VALUES (?)`).run(value);
  db.close();
}

function rows(path: string, table: string): unknown[] {
  const db = new Database(path, { readonly: true });
  try { return db.query(`SELECT value FROM ${table}`).all(); } finally { db.close(); }
}

const storeOf = (homeDir: string) => lifecycleViews().find((entry) => entry.sourceId === 'x.bookmarks')!.connectorStorePaths!({ homeDir })[0]!;
// The cheapest cost a backup accepts, so tests stay quick.
const fastKey = (passphrase: string) => deriveBackupKey(passphrase, { N: 16_384 });

function withHomes(run: (dir: string, homeA: string, homeB: string, folder: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-backup-'));
    try {
      const homeA = join(dir, 'a');
      const homeB = join(dir, 'b');
      const storeA = storeOf(homeA);
      seed(storeA, 'rows', 'a bookmark');
      seed(tierLedgerPathForStore(storeA), 'judgments', 'Private');
      await run(dir, homeA, homeB, join(dir, 'Backups'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const backupOf = (homeA: string, folder: string, extra: { key?: ReturnType<typeof fastKey>; now?: Date; keep?: number } = {}) =>
  backupOlympusData({ folder, homeDir: homeA, exportInto: (destination) => exportOlympusData({ destination, homeDir: homeA }), ...extra });

describe('data backup', () => {
  test('an encrypted backup is one file that restores with its passphrase, judgments and all', withHomes(async (_dir, homeA, homeB, folder) => {
    const result = await backupOf(homeA, folder, { key: fastKey('correct horse'), now: new Date(2026, 10, 10, 3, 10) });
    expect(readdirSync(folder)).toEqual(['olympus-backup-2026-11-10-0310.olympusbackup']);
    expect(result.encrypted).toBe(true);
    // Nothing readable: no SQLite header, no file names from the export.
    const bytes = readFileSync(result.file);
    expect(bytes.includes(Buffer.from('SQLite format 3'))).toBe(false);
    expect(bytes.includes(Buffer.from('manifest.json'))).toBe(false);
    // The staging folder is gone.
    expect(readdirSync(sharedDataPath('backup-staging', lifecycleEnv({ homeDir: homeA })))).toEqual([]);

    const restored = restoreOlympusBackup({ input: result.file, passphrase: 'correct horse', homeDir: homeB });
    expect(restored.encrypted).toBe(true);
    expect(rows(storeOf(homeB), 'rows')).toEqual([{ value: 'a bookmark' }]);
    expect(rows(tierLedgerPathForStore(storeOf(homeB)), 'judgments')).toEqual([{ value: 'Private' }]);
    expect(restored.signInAgain).toContain('x.bookmarks');
    expect(readdirSync(sharedDataPath('backup-staging', lifecycleEnv({ homeDir: homeB })))).toEqual([]);
  }));

  test('without a passphrase it is still one file, marked unencrypted, and restores', withHomes(async (_dir, homeA, homeB, folder) => {
    const result = await backupOf(homeA, folder);
    expect(readBackupHeader(result.file).header.encrypted).toBe(false);
    const restored = restoreOlympusBackup({ input: result.file, homeDir: homeB });
    expect(restored.encrypted).toBe(false);
    expect(rows(storeOf(homeB), 'rows')).toEqual([{ value: 'a bookmark' }]);
  }));

  test('a wrong passphrase, or none, is refused clearly and writes nothing', withHomes(async (_dir, homeA, homeB, folder) => {
    const result = await backupOf(homeA, folder, { key: fastKey('correct horse') });
    expect(() => restoreOlympusBackup({ input: result.file, passphrase: 'wrong horse', homeDir: homeB })).toThrow(BACKUP_WRONG_PASSPHRASE);
    expect(() => restoreOlympusBackup({ input: result.file, homeDir: homeB })).toThrow('This backup is encrypted. Enter its passphrase.');
    expect(existsSync(storeOf(homeB))).toBe(false);
  }));

  test('a changed byte anywhere in the file restores nothing', withHomes(async (_dir, homeA, homeB, folder) => {
    for (const key of [fastKey('correct horse'), undefined]) {
      rmSync(folder, { recursive: true, force: true });
      const result = await backupOf(homeA, folder, key ? { key } : {});
      const original = readFileSync(result.file);
      const { bodyStart } = readBackupHeader(result.file);
      for (const at of [bodyStart + 10, bodyStart + 700, original.length - 3]) {
        const changed = Buffer.from(original);
        changed[at] = changed[at]! ^ 0xff;
        writeFileSync(result.file, changed);
        expect(() => restoreOlympusBackup({ input: result.file, passphrase: 'correct horse', homeDir: homeB })).toThrow(BACKUP_CHANGED);
        expect(existsSync(storeOf(homeB))).toBe(false);
      }
      // The header is covered too: marking an encrypted backup's time differently fails the tag.
      if (key) {
        const text = original.toString('latin1').replace(/"created_at":"\d/, (match) => match.slice(0, -1) + (match.endsWith('1') ? '2' : '1'));
        writeFileSync(result.file, Buffer.from(text, 'latin1'));
        expect(() => restoreOlympusBackup({ input: result.file, passphrase: 'correct horse', homeDir: homeB })).toThrow(BACKUP_CHANGED);
      }
    }
    expect(readdirSync(sharedDataPath('backup-staging', lifecycleEnv({ homeDir: homeB })))).toEqual([]);
  }));

  test('a file that is not a backup is named as such', withHomes(async (dir, _homeA, homeB) => {
    const file = join(dir, 'notes.olympusbackup');
    writeFileSync(file, 'hello');
    expect(() => restoreOlympusBackup({ input: file, homeDir: homeB })).toThrow('is not an Olympus backup');
  }));

  test('a backup folder keeps the newest seven Olympus backups and nothing else is touched', withHomes(async (dir, _homeA, _homeB, folder) => {
    const exportDir = join(dir, 'export');
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(join(exportDir, 'manifest.json'), '{}');
    mkdirSync(folder, { recursive: true });
    // Look-alikes: a backup's name on another file, and an unrelated file.
    writeFileSync(join(folder, 'olympus-backup-2020-01-01-0000.olympusbackup'), 'not a backup');
    writeFileSync(join(folder, 'holiday.jpg'), 'photo');
    for (let day = 1; day <= 9; day += 1) {
      await writeBackupFile({ exportDir, folder, now: new Date(2026, 10, day, 3, 10) });
    }
    const removed = pruneBackups(folder);
    expect(removed).toEqual([backupFileName(new Date(2026, 10, 2, 3, 10)), backupFileName(new Date(2026, 10, 1, 3, 10))]);
    expect(listBackups(folder).map((backup) => backup.name)).toEqual(
      [9, 8, 7, 6, 5, 4, 3].map((day) => backupFileName(new Date(2026, 10, day, 3, 10))),
    );
    expect(existsSync(join(folder, 'olympus-backup-2020-01-01-0000.olympusbackup'))).toBe(true);
    expect(existsSync(join(folder, 'holiday.jpg'))).toBe(true);
  }));

  test('a renamed or duplicated backup is offered for restore, but retention keeps to its own names', withHomes(async (dir, _homeA, _homeB, folder) => {
    const exportDir = join(dir, 'export');
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(join(exportDir, 'manifest.json'), '{}');
    const original = await writeBackupFile({ exportDir, folder, now: new Date(2026, 10, 10, 3, 10) });
    const bytes = readFileSync(original.path);
    // A second download of the same file, and a copy the owner renamed.
    writeFileSync(join(folder, 'olympus-backup-2026-11-10-0310 (1).olympusbackup'), bytes);
    writeFileSync(join(folder, 'before the move.olympusbackup'), bytes);
    // Not a backup, whatever its name says.
    writeFileSync(join(folder, 'notes.olympusbackup'), 'hello');
    expect(listBackups(folder, { anyName: true }).map((backup) => backup.name).sort()).toEqual([
      'before the move.olympusbackup',
      'olympus-backup-2026-11-10-0310 (1).olympusbackup',
      original.name,
    ].sort());
    expect(listBackups(folder).map((backup) => backup.name)).toEqual([original.name]);
    expect(pruneBackups(folder, 0)).toEqual([original.name]);
    expect(existsSync(join(folder, 'before the move.olympusbackup'))).toBe(true);
    expect(existsSync(join(folder, 'olympus-backup-2026-11-10-0310 (1).olympusbackup'))).toBe(true);
  }));

  test('a backup is never written with a key setting no restore could open', withHomes(async (dir, _homeA, _homeB, folder) => {
    const exportDir = join(dir, 'export');
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(join(exportDir, 'manifest.json'), '{}');
    const key = fastKey('correct horse battery');
    await expect(writeBackupFile({ exportDir, folder, key: { ...key, kdf: { ...key.kdf, N: 0 } } })).rejects.toThrow('key setting');
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
  }));

  test('a file too large for the archive format is refused before any backup is written', withHomes(async (dir, _homeA, _homeB, folder) => {
    const exportDir = join(dir, 'export');
    mkdirSync(join(exportDir, 'stores'), { recursive: true });
    writeFileSync(join(exportDir, 'manifest.json'), '{}');
    // A sparse file: its size is 64 GiB, but no disk space is used.
    writeFileSync(join(exportDir, 'stores', 'big.sqlite'), '');
    truncateSync(join(exportDir, 'stores', 'big.sqlite'), USTAR_MAX_SIZE + 1);
    await expect(writeBackupFile({ exportDir, folder })).rejects.toThrow('too large to back up');
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
  }));

  test('a second backup in the same minute gets its own name', withHomes(async (dir, _homeA, _homeB, folder) => {
    const exportDir = join(dir, 'export');
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(join(exportDir, 'manifest.json'), '{}');
    const now = new Date(2026, 10, 10, 3, 10);
    await writeBackupFile({ exportDir, folder, now });
    const second = await writeBackupFile({ exportDir, folder, now });
    expect(second.name).toBe('olympus-backup-2026-11-10-0310-2.olympusbackup');
    expect(listBackups(folder).map((backup) => backup.name)).toEqual([second.name, 'olympus-backup-2026-11-10-0310.olympusbackup']);
  }));
});
