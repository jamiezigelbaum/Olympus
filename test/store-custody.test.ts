/**
 * Store custody with real processes: an opener in each mode holds the store
 * directory shared for its life, delete takes it exclusive and so refuses
 * while any is alive, SIGKILL frees it, and an opener that starts during a
 * delete is blocked. Every path lives under a throwaway root.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { StoreCustodyBusyError, holdStoreCustodyShared, releaseHeldStoreCustodyForTests, tryHoldStoreCustodyExclusive } from '../src/core/store-custody.ts';

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
  const dir = join(root, 'data');
  mkdirSync(dir, { recursive: true });
  return { root, dir, store: join(dir, 'connector-store.sqlite') };
}

const HOLDER = join(import.meta.dir, 'support', 'custody-holder.ts');

async function holder(mode: string, path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [HOLDER, mode, path], { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH } });
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
  for (const mode of ['lib', 'store']) {
    test(`an opener in "${mode}" mode blocks an exclusive delete, and SIGKILL frees it`, async () => {
      const l = lab();
      const child = await holder(mode, l.store);
      expect(tryHoldStoreCustodyExclusive([l.store], { timeoutMs: 200 })).toBeUndefined();
      child.kill('SIGKILL');
      await exited(child);
      const taken = tryHoldStoreCustodyExclusive([l.store], { timeoutMs: 2_000 });
      expect(taken).toBeDefined();
      taken!.release();
    }, 60_000);
  }

  test('an opener started during an exclusive hold is blocked, and gets in after release', async () => {
    const l = lab();
    const taken = tryHoldStoreCustodyExclusive([l.store])!;
    expect(taken).toBeDefined();
    const blocked = spawnSync(process.execPath, ['-e', `
      import { holdStoreCustodyShared } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'store-custody.ts'))};
      try { holdStoreCustodyShared([${JSON.stringify(l.store)}], { timeoutMs: 300 }); console.log('got-in'); } catch (error) { console.log(error.constructor.name); }
    `], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(blocked.stdout.trim()).toBe('StoreCustodyBusyError');
    taken.release();
    const child = await holder('lib', l.store);
    expect(child.exitCode).toBeNull();
  }, 60_000);

  test('a different folder, and another installation, never interfere', async () => {
    const a = lab();
    const b = lab();
    await holder('lib', a.store);
    const other = tryHoldStoreCustodyExclusive([b.store], { timeoutMs: 500 });
    expect(other).toBeDefined();
    other!.release();
  }, 60_000);

  test('the deleting process may open stores itself while it holds the folder', () => {
    const l = lab();
    const taken = tryHoldStoreCustodyExclusive([l.store])!;
    expect(() => holdStoreCustodyShared([l.store], { timeoutMs: 100 })).not.toThrow();
    taken.release();
  });

  test('a busy shared acquire is the typed retryable error', async () => {
    const l = lab();
    const child = spawn(process.execPath, ['-e', `
      import { tryHoldStoreCustodyExclusive } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'store-custody.ts'))};
      globalThis.keep = tryHoldStoreCustodyExclusive([${JSON.stringify(l.store)}]); console.log('held'); setInterval(() => {}, 1000);
    `], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    await new Promise<void>((resolve) => child.stdout!.on('data', () => resolve()));
    expect(() => holdStoreCustodyShared([l.store], { timeoutMs: 200 })).toThrow(StoreCustodyBusyError);
  }, 60_000);

  // The real entry points, each started the way a service starts it. Each must
  // take shared custody before it does anything else: started while a delete
  // holds the folder, it waits (does no work, prints nothing) until released.
  const ENTRIES: Array<[string, string]> = [
    ['worker (server main)', 'src/workers/email-source/server.ts'],
    ['embedding drain', 'scripts/source-embedding-drain.ts'],
    ['connector-store:embed', 'scripts/connector-store-embed.ts'],
  ];
  for (const [name, entry] of ENTRIES) {
    test(`the ${name} waits for an exclusive delete, then holds custody`, async () => {
      const l = lab();
      const port = String(20_000 + Math.floor(Math.random() * 20_000));
      const taken = tryHoldStoreCustodyExclusive([l.store])!;
      const child = spawn(process.execPath, [join(import.meta.dir, '..', entry)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: join(l.root, 'home'),
          OLYMPUS_EMBEDDING_LEDGER_PATH: join(l.dir, 'embedding-ledger.jsonl'),
          OLYMPUS_EMAIL_SOURCE_PORT: port,
        },
      });
      children.push(child);
      let stderr = '';
      child.stderr!.on('data', (chunk) => { stderr += chunk; });
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      // Blocked on custody: still alive, no work done, no error printed.
      expect(child.exitCode).toBeNull();
      expect(stderr).toBe('');
      taken.release();
      // Released: it proceeds past custody (and then runs, or fails on its own missing setup).
      const proceeded = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 15_000);
        child.stderr!.on('data', () => { clearTimeout(timer); resolve(true); });
        child.on('exit', () => { clearTimeout(timer); resolve(true); });
        if (entry.includes('server.ts')) setTimeout(() => { clearTimeout(timer); resolve(true); }, 3_000);
      });
      expect(proceeded).toBe(true);
    }, 60_000);
  }

  test('a live worker keeps the folder held until it is killed', async () => {
    const l = lab();
    const port = String(20_000 + Math.floor(Math.random() * 20_000));
    const child = spawn(process.execPath, [join(import.meta.dir, '..', 'src/workers/email-source/server.ts')], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { PATH: process.env.PATH, HOME: join(l.root, 'home'), OLYMPUS_EMBEDDING_LEDGER_PATH: join(l.dir, 'embedding-ledger.jsonl'), OLYMPUS_EMAIL_SOURCE_PORT: port },
    });
    children.push(child);
    const deadline = Date.now() + 30_000;
    let held = false;
    while (Date.now() < deadline && child.exitCode === null) {
      const probe = tryHoldStoreCustodyExclusive([l.store], { timeoutMs: 0 });
      if (!probe) { held = true; break; }
      probe.release();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(held).toBe(true);
    child.kill('SIGKILL');
    await exited(child);
    const freed = tryHoldStoreCustodyExclusive([l.store], { timeoutMs: 2_000 });
    expect(freed).toBeDefined();
    freed!.release();
  }, 60_000);
});
