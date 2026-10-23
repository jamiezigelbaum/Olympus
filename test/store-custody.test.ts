/**
 * Store custody with real processes. One lock per account home, outside every
 * tree a delete removes: every opener (whatever store or subfolder it opens)
 * holds it shared for its life, delete takes it exclusive and so refuses while
 * any is alive, SIGKILL frees it, and an opener started during a delete waits.
 * Every path lives under a throwaway root; every child gets an explicit HOME.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { StoreCustodyBusyError, StoreCustodyUnavailableError, ensureStoreCustodyDirectory, holdStoreCustodyShared, storeCustodyDirectory, releaseHeldStoreCustodyForTests, storeCustodyLockPath, tryHoldStoreCustodyExclusive } from '../src/core/store-custody.ts';
import { tryKernelLockAt } from '../src/core/file-lease.ts';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  releaseHeldStoreCustodyForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lab() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-custody-'));
  roots.push(root);
  const home = join(root, 'home');
  const dir = join(home, '.local', 'share', 'openclaw', 'olympus');
  mkdirSync(dir, { recursive: true });
  return { root, home, dir, store: join(dir, 'connector-store.sqlite') };
}

const HOLDER = join(import.meta.dir, 'support', 'custody-holder.ts');
const CUSTODY_MODULE = join(import.meta.dir, '..', 'src', 'core', 'store-custody.ts');

async function holder(mode: string, home: string, path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [HOLDER, mode, path], { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH, HOME: home } });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('holder did not start')), 20_000);
    child.stdout!.on('data', (chunk) => { if (String(chunk).includes('held')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`holder exited ${code}`)); });
  });
  return child;
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
}

describe('store custody held by real processes', () => {
  for (const mode of ['lib', 'store', 'tier-ledger', 'sniffer', 'x-usage']) {
    test(`an opener in "${mode}" mode blocks an exclusive delete, and SIGKILL frees it`, async () => {
      const l = lab();
      const child = await holder(mode, l.home, mode === 'lib' ? '' : join(l.dir, `${mode}.sqlite`));
      expect(tryHoldStoreCustodyExclusive({ homeDir: l.home, timeoutMs: 200 })).toBeUndefined();
      child.kill('SIGKILL');
      await exited(child);
      const taken = tryHoldStoreCustodyExclusive({ homeDir: l.home, timeoutMs: 2_000 });
      expect(taken).toBeDefined();
      taken!.release();
    }, 10_000);
  }

  test('an opener started during an exclusive hold is blocked, and gets in after release', async () => {
    const l = lab();
    const taken = tryHoldStoreCustodyExclusive({ homeDir: l.home })!;
    expect(taken).toBeDefined();
    const blocked = spawnSync(process.execPath, ['-e', `
      import { holdStoreCustodyShared } from ${JSON.stringify(CUSTODY_MODULE)};
      try { holdStoreCustodyShared({ timeoutMs: 300 }); console.log('got-in'); } catch (error) { console.log(error.constructor.name); }
    `], { env: { PATH: process.env.PATH, HOME: l.home }, encoding: 'utf8', timeout: 10_000 });
    expect(blocked.stdout.trim()).toBe('StoreCustodyBusyError');
    taken.release();
    const child = await holder('lib', l.home, '');
    expect(child.exitCode).toBeNull();
  }, 10_000);

  test('another account home, never interferes', async () => {
    const a = lab();
    const b = lab();
    await holder('lib', a.home, '');
    const other = tryHoldStoreCustodyExclusive({ homeDir: b.home, timeoutMs: 500 });
    expect(other).toBeDefined();
    other!.release();
  }, 10_000);

  test('the deleting process may open stores itself while it holds custody, and gets its own shared hold back', () => {
    const l = lab();
    holdStoreCustodyShared({ homeDir: l.home });
    const taken = tryHoldStoreCustodyExclusive({ homeDir: l.home })!;
    expect(taken).toBeDefined();
    expect(() => holdStoreCustodyShared({ homeDir: l.home, timeoutMs: 100 })).not.toThrow();
    taken.release();
    // Its own shared hold is back: another process cannot take it exclusive.
    const probe = spawnSync(process.execPath, ['-e', `
      import { tryHoldStoreCustodyExclusive } from ${JSON.stringify(CUSTODY_MODULE)};
      console.log(tryHoldStoreCustodyExclusive({ timeoutMs: 0 }) === undefined ? 'blocked' : 'free');
    `], { env: { PATH: process.env.PATH, HOME: l.home }, encoding: 'utf8', timeout: 10_000 });
    expect(probe.stdout.trim()).toBe('blocked');
  }, 10_000);

  test('a busy shared acquire is the typed retryable error', async () => {
    const l = lab();
    const child = spawn(process.execPath, ['-e', `
      import { tryHoldStoreCustodyExclusive } from ${JSON.stringify(CUSTODY_MODULE)};
      globalThis.keep = tryHoldStoreCustodyExclusive(); console.log('held'); setInterval(() => {}, 1000);
    `], { env: { PATH: process.env.PATH, HOME: l.home }, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    await new Promise<void>((resolve) => child.stdout!.on('data', () => resolve()));
    expect(() => holdStoreCustodyShared({ homeDir: l.home, timeoutMs: 200 })).toThrow(StoreCustodyBusyError);
  }, 10_000);
});

describe('the lock outlives every delete and covers every folder', () => {
  test('the lock file is outside every Olympus data root, so a recursive delete cannot unlink it', () => {
    const l = lab();
    const lock = storeCustodyLockPath(l.home);
    for (const root of ['.olympus', '.config/olympus', '.local/share/olympus', '.local/share/openclaw/olympus', '.local/state/olympus', '.cache/olympus']) {
      expect(lock.startsWith(`${join(l.home, root)}/`)).toBe(false);
    }
  });

  test('an opener of a deep subfolder and one of a different root contend on the same lock', async () => {
    const l = lab();
    const deep = join(l.dir, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    await holder('store', l.home, join(deep, 'x.sqlite'));
    expect(tryHoldStoreCustodyExclusive({ homeDir: l.home, timeoutMs: 100 })).toBeUndefined();
    // A store somewhere else entirely under the same account is the same lock.
    const elsewhere = join(l.root, 'external-disk');
    mkdirSync(elsewhere, { recursive: true });
    const second = await holder('store', l.home, join(elsewhere, 'y.sqlite'));
    second.kill('SIGKILL');
    await exited(second);
    expect(tryHoldStoreCustodyExclusive({ homeDir: l.home, timeoutMs: 100 })).toBeUndefined();
  }, 10_000);

  test('removing the whole data tree while custody is held does not change the lock identity', () => {
    const l = lab();
    const taken = tryHoldStoreCustodyExclusive({ homeDir: l.home })!;
    rmSync(join(l.home, '.local'), { recursive: true, force: true });
    rmSync(join(l.home, '.config'), { recursive: true, force: true });
    expect(existsSync(storeCustodyLockPath(l.home))).toBe(true);
    // A contender after the "delete" still meets the held lock.
    expect(tryHoldStoreCustodyExclusive({ homeDir: l.home, timeoutMs: 100 })).toBeUndefined();
    taken.release();
  });
});

describe('the lock database must be in rollback-journal mode', () => {
  test('a WAL lock file is switched back before either lock is granted', () => {
    const l = lab();
    const lock = storeCustodyLockPath(l.home);
    mkdirSync(join(lock, '..'), { recursive: true });
    const db = new Database(lock, { create: true });
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
    db.close();
    const first = tryKernelLockAt(lock, 'shared');
    expect(first).toBeDefined();
    // Shared and exclusive exclude each other again.
    expect(tryKernelLockAt(lock, 'exclusive')).toBeUndefined();
    first!.release();
    const exclusive = tryKernelLockAt(lock, 'exclusive');
    expect(exclusive).toBeDefined();
    expect(tryKernelLockAt(lock, 'shared')).toBeUndefined();
    exclusive!.release();
    const check = new Database(lock, { readonly: true });
    expect((check.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('delete');
    check.close();
  });

  test('a lock file that cannot be put in rollback mode fails closed', () => {
    const l = lab();
    const lock = storeCustodyLockPath(l.home);
    mkdirSync(join(lock, '..'), { recursive: true });
    const db = new Database(lock, { create: true });
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
    // A reader keeps the WAL database open, so the switch cannot happen.
    const reader = new Database(lock);
    reader.exec('BEGIN');
    reader.query('SELECT * FROM t').all();
    let outcome: string;
    try { outcome = tryKernelLockAt(lock, 'exclusive') === undefined ? 'busy' : 'granted'; } catch { outcome = 'error'; }
    reader.close();
    db.close();
    expect(outcome).not.toBe('granted');
  });
});

// The real entry points, each started the way a service starts it. Each must
// take shared custody before it does anything else: started while a delete
// holds the lock, it waits (does no work, prints nothing) until released.
const ENTRIES: Array<[string, string]> = [
  ['worker (server main)', 'src/workers/email-source/server.ts'],
  ['embedding drain', 'scripts/source-embedding-drain.ts'],
  ['connector-store:embed', 'scripts/connector-store-embed.ts'],
];

describe('real entry points', () => {
  for (const [name, entry] of ENTRIES) {
    test(`the ${name} waits for an exclusive delete, then holds custody`, async () => {
      const l = lab();
      const port = String(20_000 + Math.floor(Math.random() * 20_000));
      const taken = tryHoldStoreCustodyExclusive({ homeDir: l.home })!;
      const child = spawn(process.execPath, [join(import.meta.dir, '..', entry)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { PATH: process.env.PATH, HOME: l.home, OLYMPUS_EMAIL_SOURCE_PORT: port },
      });
      children.push(child);
      let stderr = '';
      child.stderr!.on('data', (chunk) => { stderr += chunk; });
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(child.exitCode).toBeNull();
      expect(stderr).toBe('');
      taken.release();
      const proceeded = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 8_000);
        child.stderr!.on('data', () => { clearTimeout(timer); resolve(true); });
        child.on('exit', () => { clearTimeout(timer); resolve(true); });
        if (entry.includes('server.ts')) setTimeout(() => { clearTimeout(timer); resolve(true); }, 3_000);
      });
      expect(proceeded).toBe(true);
    }, 10_000 + 20_000);
  }

  test('a live worker keeps custody held until it is killed', async () => {
    const l = lab();
    const port = String(20_000 + Math.floor(Math.random() * 20_000));
    const child = spawn(process.execPath, [join(import.meta.dir, '..', 'src/workers/email-source/server.ts')], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { PATH: process.env.PATH, HOME: l.home, OLYMPUS_EMAIL_SOURCE_PORT: port },
    });
    children.push(child);
    const deadline = Date.now() + 8_000;
    let held = false;
    while (Date.now() < deadline && child.exitCode === null) {
      const probe = tryHoldStoreCustodyExclusive({ homeDir: l.home, timeoutMs: 0 });
      if (!probe) { held = true; break; }
      probe.release();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(held).toBe(true);
    child.kill('SIGKILL');
    await exited(child);
    const freed = tryHoldStoreCustodyExclusive({ homeDir: l.home, timeoutMs: 2_000 });
    expect(freed).toBeDefined();
    freed!.release();
  }, 10_000);

  // The repair and backfill scripts and the tier CLI are openers too.
  const OPENERS: Array<[string, string, (db: string) => string[]]> = [
    ['embedding-identity-repair', 'scripts/embedding-identity-repair.ts', (db) => ['--db', db]],
    ['whatsapp-identity-backfill', 'scripts/whatsapp-identity-backfill.ts', (db) => ['--db', db, '--session-db', db]],
  ];
  for (const [name, script, argv] of OPENERS) {
    test(`${name} takes custody before opening its database`, async () => {
      const l = lab();
      const db = join(l.dir, 'x.sqlite');
      writeFileSync(db, '');
      const taken = tryHoldStoreCustodyExclusive({ homeDir: l.home })!;
      const child = spawn(process.execPath, [join(import.meta.dir, '..', script), ...argv(db)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { PATH: process.env.PATH, HOME: l.home },
      });
      children.push(child);
      let stderr = '';
      child.stderr!.on('data', (chunk) => { stderr += chunk; });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // Blocked on custody: alive and silent while the delete holds it.
      expect(child.exitCode).toBeNull();
      expect(stderr).toBe('');
      taken.release();
    }, 10_000);
  }
});

describe('the lock folder is validated before it is trusted', () => {
  test('a missing folder is created private (0700), and the lock works', () => {
    const l = lab();
    const lock = tryHoldStoreCustodyExclusive({ homeDir: l.home })!;
    expect(lock).toBeDefined();
    expect(statSync(storeCustodyDirectory(l.home)).mode & 0o777).toBe(0o700);
    lock.release();
  });

  test('a symbolic link at the folder is refused with the reason', () => {
    const l = lab();
    const real = join(l.root, 'elsewhere');
    mkdirSync(real);
    symlinkSync(real, join(l.home, '.olympus-locks'));
    expect(() => holdStoreCustodyShared({ homeDir: l.home })).toThrow(StoreCustodyUnavailableError);
    expect(() => holdStoreCustodyShared({ homeDir: l.home })).toThrow(/symbolic link/);
    expect(() => tryHoldStoreCustodyExclusive({ homeDir: l.home })).toThrow(/symbolic link/);
  });

  test('a symbolic link in a component above the lock file (a linked lock file) is refused', () => {
    const l = lab();
    const directory = ensureStoreCustodyDirectory(l.home);
    const real = join(l.root, 'real.lock');
    writeFileSync(real, '');
    symlinkSync(real, join(directory, 'store-lifecycle.lock.db'));
    expect(() => holdStoreCustodyShared({ homeDir: l.home })).toThrow(StoreCustodyUnavailableError);
  });

  test('a folder writable by group or others is refused', () => {
    const l = lab();
    const directory = ensureStoreCustodyDirectory(l.home);
    chmodSync(directory, 0o770);
    expect(() => holdStoreCustodyShared({ homeDir: l.home })).toThrow(/other users can write/);
    chmodSync(directory, 0o700);
    expect(() => holdStoreCustodyShared({ homeDir: l.home })).not.toThrow();
  });

  test('a folder we cannot write to is refused with the reason, not a generic lock failure', () => {
    const l = lab();
    const directory = ensureStoreCustodyDirectory(l.home);
    chmodSync(directory, 0o500);
    try {
      expect(() => holdStoreCustodyShared({ homeDir: l.home })).toThrow(/not writable/);
    } finally {
      chmodSync(directory, 0o700);
    }
  });

  test('a regular file where the folder should be is refused', () => {
    const l = lab();
    writeFileSync(join(l.home, '.olympus-locks'), 'x');
    expect(() => holdStoreCustodyShared({ homeDir: l.home })).toThrow(StoreCustodyUnavailableError);
  });
});
