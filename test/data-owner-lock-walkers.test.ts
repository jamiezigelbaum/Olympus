// A process that holds the data owner lock must never open the lock file apart
// from the lease: closing any descriptor a process has on a file drops all of
// that process's POSIX locks on it, so a walker that reads, copies or removes
// the lock file would silently let go of it. These tests hold the lock in THIS
// process, run each walker of the data root, and then ask a second process
// whether the lock is still held.
// Spawning tests carry an explicit timeout (test/spawn-timeout-guard.test.ts).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  dataOwnerLockPath,
  holdDataOwnerLock,
  isDataOwnerLockName,
  type HeldDataOwnerLock,
} from '../src/core/data-owner-lock.ts';
import { deleteOlympusData, exportOlympusData, lifecycleSourceSpecs, verifyOlympusDataExport } from '../src/data-lifecycle.ts';
import { olympusDataRoot } from '../src/core/olympus-layout.ts';
import { decideLocalFilesPath } from '../src/workers/local-files/scope.ts';

const roots: string[] = [];
const held: HeldDataOwnerLock[] = [];
afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MODULE = join(import.meta.dir, '..', 'src', 'core', 'data-owner-lock.ts');

function fixture(): { dir: string; homeDir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-owner-walkers-'));
  roots.push(dir);
  const homeDir = join(dir, 'home');
  return {
    dir,
    homeDir,
    env: {
      HOME: homeDir,
      XDG_DATA_HOME: join(homeDir, '.local', 'share'),
      XDG_STATE_HOME: join(homeDir, '.local', 'state'),
      PATH: process.env.PATH ?? '',
    },
  };
}

/** Whether another process can take the lock: it tries once, and says which. */
async function otherProcessSees(env: Record<string, string>): Promise<'BUSY' | 'FREE'> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-owner-probe-'));
  roots.push(dir);
  const script = join(dir, 'probe.mts');
  await Bun.write(script, `
import { tryDataOwnerLock } from ${JSON.stringify(MODULE)};
const lock = tryDataOwnerLock(process.env);
process.stdout.write(lock ? 'FREE' : 'BUSY');
lock?.release();
`);
  const child = Bun.spawn([process.execPath, script], { env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`probe failed: ${err}`);
  return out as 'BUSY' | 'FREE';
}

function seedStore(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  db.query('INSERT INTO rows (value) VALUES (?)').run('kept');
  db.close();
}

/** The folder holds the lock file and nothing but SQLite's journal names for it. */
function onlyTheLock(root: string): boolean {
  const names = readdirSync(root);
  return names.includes('data-owner.lock.db') && names.every(isDataOwnerLockName);
}

function everyFile(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? everyFile(path) : [path];
  });
}

describe('export while this process holds the lock', () => {
  test('leaves the lock held, and does not copy the lock file or its journals', async () => {
    const { dir, homeDir, env } = fixture();
    const lock = holdDataOwnerLock(env);
    held.push(lock);
    const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'x.bookmarks')!;
    const storePath = spec.connectorStorePaths!({ homeDir, env })[0]!;
    expect(storePath.startsWith(`${olympusDataRoot(env)}/`)).toBe(true);
    seedStore(storePath);
    expect(existsSync(lock.lockPath)).toBe(true);
    expect(await otherProcessSees(env)).toBe('BUSY');

    const destination = join(dir, 'export');
    const result = exportOlympusData({ destination, homeDir, env });

    // The store was exported (the walk really ran across this data root) ...
    expect(result.files.some((file) => file.endsWith('x-bookmarks-connector-store.sqlite'))).toBe(true);
    // ... and the lock file, which sits in that data root, was not.
    const exported = everyFile(destination);
    expect(exported.filter((path) => isDataOwnerLockName(path.slice(path.lastIndexOf('/') + 1)))).toEqual([]);
    expect(exported.filter((path) => path.includes('data-owner'))).toEqual([]);
    expect(result.skipped.filter((path) => path.includes('data-owner'))).toEqual([]);
    // The lock file is untouched and still held, which a second process proves.
    expect(existsSync(lock.lockPath)).toBe(true);
    expect(await otherProcessSees(env)).toBe('BUSY');

    // `data verify` reads only the export folder.
    expect(verifyOlympusDataExport({ destination }).ok).toBe(true);
    expect(await otherProcessSees(env)).toBe('BUSY');

    // The probe is not vacuous: once released, the same probe finds it free.
    lock.release();
    held.pop();
    expect(await otherProcessSees(env)).toBe('FREE');
  }, 60_000);
});

describe('delete all while this process holds the lock', () => {
  test('removes the data but keeps the lock file, and the lock stays held', async () => {
    const { homeDir, env } = fixture();
    const lock = holdDataOwnerLock(env);
    held.push(lock);
    const dataRoot = olympusDataRoot(env);
    expect(dataRoot).toBe(join(homeDir, '.local', 'share', 'openclaw', 'olympus'));
    writeFileSync(join(dataRoot, 'registry.json'), '{}');
    mkdirSync(join(dataRoot, 'sources', 'x.bookmarks', '1'), { recursive: true });
    writeFileSync(join(dataRoot, 'sources', 'x.bookmarks', '1', 'stuff.txt'), 'private');
    seedStore(join(dataRoot, 'x-bookmarks-connector-store.sqlite'));
    expect(await otherProcessSees(env)).toBe('BUSY');

    const dryRun = deleteOlympusData({ all: true, homeDir, env, dryRun: true });
    expect(dryRun.removed).toContain(dataRoot);
    expect(existsSync(join(dataRoot, 'registry.json'))).toBe(true);

    const result = deleteOlympusData({ all: true, homeDir, env });

    expect(result.removed).toContain(dataRoot);
    // Everything else in the data root is gone; what is left is the lock file and
    // the journal SQLite keeps beside it while the lock is held.
    expect(onlyTheLock(dataRoot)).toBe(true);
    expect(dataOwnerLockPath(env)).toBe(join(dataRoot, 'data-owner.lock.db'));
    expect(statSync(lock.lockPath).isFile()).toBe(true);
    expect(await otherProcessSees(env)).toBe('BUSY');

    // Run again over what is left: still not removed, still held.
    deleteOlympusData({ all: true, homeDir, env });
    expect(onlyTheLock(dataRoot)).toBe(true);
    expect(await otherProcessSees(env)).toBe('BUSY');

    lock.release();
    held.pop();
    expect(await otherProcessSees(env)).toBe('FREE');
  }, 60_000);

  test('keeps the lock file wherever it sits inside a removed folder, and removes the folder otherwise', () => {
    const { homeDir, env } = fixture();
    const dataRoot = olympusDataRoot(env);
    // Never taken: nothing to keep, so the data root goes as it always did.
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(join(dataRoot, 'registry.json'), '{}');
    deleteOlympusData({ all: true, homeDir, env });
    expect(existsSync(dataRoot)).toBe(false);

    // Taken once and released: the file is still kept (only uninstall removes it).
    holdDataOwnerLock(env).release();
    writeFileSync(join(dataRoot, 'registry.json'), '{}');
    deleteOlympusData({ all: true, homeDir, env });
    expect(readdirSync(dataRoot)).toEqual(['data-owner.lock.db']);
  });
});

describe('the whole-computer file index', () => {
  test('never lists or reads the lock file or its journals, whatever was selected', () => {
    const context = { home: '/home/jo', syncedRoots: [], platform: 'linux' } as const;
    const everything = { wholeAccount: true, selections: [{ key: '/', state: 'ingest' as const }] };
    const lockDirectory = '/home/jo/.local/share/olympus';
    for (const name of ['data-owner.lock.db', 'data-owner.lock.db-journal', 'data-owner.lock.db-wal', 'data-owner.lock.db-shm']) {
      expect(decideLocalFilesPath(everything, `${lockDirectory}/${name}`, context), name).toBe('denied');
    }
    // Its neighbours are decided as before.
    expect(decideLocalFilesPath(everything, `${lockDirectory}/notes.txt`, context)).toBe('content');
    expect(decideLocalFilesPath(everything, '/home/jo/Documents/data-owner.txt', context)).toBe('content');
  });
});
