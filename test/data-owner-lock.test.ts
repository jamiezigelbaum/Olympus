// The data owner lock (docs/design/source-storage.md, "Owner lock"): one process
// owns the data root, the kernel releases it when that process dies, and the
// worker, the operator scripts and the CLI all contend on the same file.
// Spawning tests carry an explicit timeout (test/spawn-timeout-guard.test.ts).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  DataOwnerBusyError,
  STOP_OLYMPUS_HINT,
  dataOwnerLockPath,
  dataOwnerLockTarget,
  holdDataOwnerLock,
  isDataOwnerLockName,
  takeWorkerDataOwnerLock,
  tryDataOwnerLock,
  withDataOwnerLock,
  withDataOwnerLockIfFree,
} from '../src/core/data-owner-lock.ts';
import { olympusDataRoot } from '../src/core/olympus-layout.ts';

const roots: string[] = [];
const children: Array<{ kill(signal?: number | NodeJS.Signals): void }> = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MODULE = join(import.meta.dir, '..', 'src', 'core', 'data-owner-lock.ts');

/** An isolated home and XDG data home: the lock lives under the latter. */
function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'olympus-owner-lock-'));
  roots.push(root);
  return {
    HOME: join(root, 'home'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    PATH: process.env.PATH ?? '',
    ...extra,
  };
}

/** A child process that takes the lock, says HELD, then holds it (or exits after `holdMs`). */
async function startHolder(env: Record<string, string>, holdMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-owner-holder-'));
  roots.push(dir);
  const script = join(dir, 'holder.mts');
  await Bun.write(script, `
import { holdDataOwnerLock } from ${JSON.stringify(MODULE)};
// Held in module state, as the worker does: a handle nothing references is
// collected, which closes its connection and lets go of the lock.
globalThis.heldDataOwnerLock = holdDataOwnerLock(process.env);
for (let round = 0; round < 3; round += 1) { Bun.gc(true); await Bun.sleep(100); }
process.stdout.write('HELD\\n');
${holdMs === undefined ? 'setInterval(() => {}, 1000);' : `setTimeout(() => process.exit(0), ${holdMs});`}
`);
  const child = Bun.spawn([process.execPath, script], { env, stdout: 'pipe', stderr: 'pipe' });
  children.push(child);
  const reader = child.stdout.getReader();
  let seen = '';
  while (!seen.includes('HELD')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`holder exited: ${await new Response(child.stderr).text()}`);
    seen += new TextDecoder().decode(value);
  }
  return child;
}

describe('where the lock lives', () => {
  test('in the data root that XDG_DATA_HOME resolves, as data-owner.lock.db', () => {
    const env = isolatedEnv();
    expect(olympusDataRoot(env)).toBe(join(env.XDG_DATA_HOME!, 'openclaw', 'olympus'));
    expect(dataOwnerLockTarget(env)).toBe(join(olympusDataRoot(env), 'data-owner'));
    expect(dataOwnerLockPath(env)).toBe(join(olympusDataRoot(env), 'data-owner.lock.db'));
    expect(existsSync(dataOwnerLockPath(env))).toBe(false);

    const lock = holdDataOwnerLock(env);
    try {
      expect(lock.lockPath).toBe(dataOwnerLockPath(env));
      expect(lock.root).toBe(olympusDataRoot(env));
      expect(existsSync(lock.lockPath)).toBe(true);
    } finally {
      lock.release();
    }
    // Released, not removed: only uninstall removes the file.
    expect(existsSync(dataOwnerLockPath(env))).toBe(true);
  });

  test('walkers recognise the lock file and the journal files SQLite keeps beside it, and nothing else', () => {
    for (const name of ['data-owner.lock.db', 'data-owner.lock.db-journal', 'data-owner.lock.db-wal', 'data-owner.lock.db-shm']) {
      expect(isDataOwnerLockName(name), name).toBe(true);
    }
    for (const name of ['data-owner', 'data-owner.json', 'registry.json', 'registry.json.lock.db', 'other.lock.db']) {
      expect(isDataOwnerLockName(name), name).toBe(false);
    }
  });
});

describe('a lock held by another process', () => {
  test('makes this one busy, naming the data root and how to stop Olympus', async () => {
    const env = isolatedEnv();
    await startHolder(env);

    let caught: unknown;
    try { holdDataOwnerLock(env); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DataOwnerBusyError);
    const busy = caught as DataOwnerBusyError;
    expect(busy.code).toBe('data_owner_busy');
    expect(busy.root).toBe(olympusDataRoot(env));
    expect(busy.message).toContain(`Olympus is running and owns its data at ${olympusDataRoot(env)}`);
    expect(busy.message).toContain('olympus engine stop');
    expect(busy.message).toContain(STOP_OLYMPUS_HINT);
  }, 20_000);

  test('is held against another process that resolves the same data root with other state folders', async () => {
    const env = isolatedEnv();
    await startHolder({ ...env, XDG_STATE_HOME: join(env.HOME!, 'state-one'), XDG_CONFIG_HOME: join(env.HOME!, 'config-one') });
    const other = { ...env, XDG_STATE_HOME: join(env.HOME!, 'state-two'), XDG_CONFIG_HOME: join(env.HOME!, 'config-two') };
    expect(() => holdDataOwnerLock(other)).toThrow(DataOwnerBusyError);
  }, 20_000);

  test('is freed at once when the holder is killed', async () => {
    const env = isolatedEnv();
    const holder = await startHolder(env);
    expect(() => holdDataOwnerLock(env)).toThrow(DataOwnerBusyError);

    holder.kill('SIGKILL');
    await (holder as unknown as { exited: Promise<number> }).exited;
    // Nothing is cleaned up by hand: the kernel let go with the process.
    const lock = holdDataOwnerLock(env);
    lock.release();
  }, 20_000);

  test('tryDataOwnerLock answers undefined while it is held, and a handle once it is free', async () => {
    const env = isolatedEnv();
    const holder = await startHolder(env);
    expect(tryDataOwnerLock(env)).toBeUndefined();

    holder.kill('SIGKILL');
    await (holder as unknown as { exited: Promise<number> }).exited;
    const lock = tryDataOwnerLock(env);
    expect(lock).toBeDefined();
    // And a handle really holds it: a second try, in this process, finds it busy.
    expect(tryDataOwnerLock(env)).toBeUndefined();
    lock!.release();
    const again = tryDataOwnerLock(env);
    expect(again).toBeDefined();
    again!.release();
  }, 20_000);

  test('waitMs rides out a holder that is on its way out (a restart overlaps the old worker)', async () => {
    const env = isolatedEnv();
    await startHolder(env, 400);
    const started = Date.now();
    const lock = holdDataOwnerLock(env, { waitMs: 5_000 });
    try {
      expect(Date.now() - started).toBeLessThan(4_500);
    } finally {
      lock.release();
    }
  }, 20_000);
});

describe('two takers in one process', () => {
  test('never deadlock: the second finds it busy, the way a CLI command finds the worker inside a gateway', () => {
    const env = isolatedEnv();
    const worker = holdDataOwnerLock(env);
    try {
      expect(() => holdDataOwnerLock(env)).toThrow(DataOwnerBusyError);
      expect(tryDataOwnerLock(env)).toBeUndefined();
    } finally {
      worker.release();
    }
  });

  test('withDataOwnerLockIfFree runs the command whether or not it got the lock, and lets go after', async () => {
    const env = isolatedEnv();
    const ran: string[] = [];

    // Free: the command holds the lock while it runs.
    await withDataOwnerLockIfFree(() => {
      ran.push('free');
      expect(tryDataOwnerLock(env)).toBeUndefined();
    }, env);
    const freed = tryDataOwnerLock(env);
    expect(freed).toBeDefined();

    // Busy (the worker runs): the command still runs, as it did before the lock existed.
    expect(await withDataOwnerLockIfFree(() => { ran.push('busy'); return 7; }, env)).toBe(7);
    // The lock the command did not take is still the worker's.
    expect(tryDataOwnerLock(env)).toBeUndefined();
    freed!.release();

    // A throwing command still releases what it took.
    await expect(withDataOwnerLockIfFree(() => { throw new Error('command failed'); }, env)).rejects.toThrow('command failed');
    const after = tryDataOwnerLock(env);
    expect(after).toBeDefined();
    after!.release();
    expect(ran).toEqual(['free', 'busy']);
  });
});

describe('withDataOwnerLock', () => {
  test('holds the lock around the call and returns its value', () => {
    const env = isolatedEnv();
    const seen = withDataOwnerLock(env, () => {
      expect(tryDataOwnerLock(env)).toBeUndefined();
      return 'ran';
    });
    expect(seen).toBe('ran');
    const lock = tryDataOwnerLock(env);
    expect(lock).toBeDefined();
    lock!.release();
  });

  test('releases when the call throws', () => {
    const env = isolatedEnv();
    expect(() => withDataOwnerLock(env, () => { throw new Error('boom'); })).toThrow('boom');
    const lock = tryDataOwnerLock(env);
    expect(lock).toBeDefined();
    lock!.release();
  });

  test('holds across an async call and releases when it settles, rejected or not', async () => {
    const env = isolatedEnv();
    const value = await withDataOwnerLock(env, async () => {
      await Promise.resolve();
      expect(tryDataOwnerLock(env)).toBeUndefined();
      return 3;
    });
    expect(value).toBe(3);
    await expect(withDataOwnerLock(env, async () => { throw new Error('async boom'); })).rejects.toThrow('async boom');
    const lock = tryDataOwnerLock(env);
    expect(lock).toBeDefined();
    lock!.release();
  });

  test('does not run the call at all while another process owns the data', async () => {
    const env = isolatedEnv();
    await startHolder(env);
    let ran = false;
    expect(() => withDataOwnerLock(env, () => { ran = true; })).toThrow(DataOwnerBusyError);
    expect(ran).toBe(false);
  }, 20_000);
});

describe('the worker boot step', () => {
  class Exited extends Error {
    constructor(readonly code: number) { super(`exit ${code}`); }
  }
  const exit = (code: number): never => { throw new Exited(code); };

  test('on a free data root, takes the lock and returns it', () => {
    const env = isolatedEnv();
    const lines: string[] = [];
    const lock = takeWorkerDataOwnerLock(env, { exit, report: (line) => lines.push(line) });
    try {
      expect(lock.root).toBe(olympusDataRoot(env));
      expect(lines).toEqual([]);
      expect(tryDataOwnerLock(env)).toBeUndefined();
    } finally {
      lock.release();
    }
  });

  test('a second worker on a held data root reports one line and exits non-zero', async () => {
    const env = isolatedEnv();
    await startHolder(env);
    const lines: string[] = [];

    let exited: Exited | undefined;
    try {
      takeWorkerDataOwnerLock(env, { waitMs: 150, exit, report: (line) => lines.push(line) });
    } catch (error) {
      if (!(error instanceof Exited)) throw error;
      exited = error;
    }
    expect(exited?.code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`Another Olympus already owns its data at ${olympusDataRoot(env)}`);
    expect(lines[0]).toContain('this worker is exiting');
    expect(lines[0]).toContain(STOP_OLYMPUS_HINT);
  }, 20_000);

  test('main() takes the lock first, before the registry adoption switch and anything that mounts', () => {
    // main() is the process entry (it starts the server), so this holds the order in the source.
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'workers', 'email-source', 'server.ts'), 'utf8');
    const opening = 'export async function main(): Promise<void> {';
    const body = source.slice(source.indexOf(opening) + opening.length);
    const beforeTake = body.slice(0, body.indexOf('dataOwnerLock = takeWorkerDataOwnerLock('));
    expect(body.indexOf('takeWorkerDataOwnerLock(')).toBeGreaterThan(-1);
    expect(beforeTake.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('//'))).toEqual([]);
    expect(body.indexOf('enableSourceRegistryAdoption()')).toBeGreaterThan(body.indexOf('takeWorkerDataOwnerLock('));
  });
});

describe('the embedding drain in http mode', () => {
  test('opens no store, so it runs beside the worker that owns the data', async () => {
    const env = isolatedEnv();
    await startHolder(env);
    mkdirSync(env.HOME!, { recursive: true });
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname);
        return Response.json({ chunks_seen: 0, chunks_embedded: 0, chunks_skipped: 0, status: 'completed' });
      },
    });
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'scripts', 'source-embedding-drain.ts')], {
        env: {
          ...env,
          OLYMPUS_CONFIG: join(env.HOME!, 'missing-config.json'),
          OLYMPUS_SOURCE_EMBEDDING_DRAIN_ENABLED: 'true',
          OLYMPUS_SOURCE_EMBEDDING_DRAIN_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
          OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_RUNS: '1',
          OLYMPUS_SOURCE_EMBEDDING_DRAIN_STOP_WHEN_IDLE: 'true',
          OLYMPUS_SOURCE_EMBEDDING_DRAIN_IDLE_SLEEP_SECONDS: '0',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      children.push(child);
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(stderr).not.toContain('owns its data');
      expect(code).toBe(0);
      expect(requests).toContain('/v1/source/index/embed');
    } finally {
      server.stop(true);
    }
  }, 60_000);
});

describe('an operator script', () => {
  const scripts = [
    ['telegram-trust-reconcile.ts', []],
    ['source-eval-pack-inspect.ts', []],
    ['source-embedding-drain.ts', ['--dry-run']],
  ] as const;

  for (const [name, args] of scripts) {
    test(`${name} refuses while Olympus owns the data, with the stop command and a non-zero exit`, async () => {
      const env = isolatedEnv();
      await startHolder(env);
      mkdirSync(env.HOME!, { recursive: true });
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'scripts', name), ...args], {
        env, stdout: 'pipe', stderr: 'pipe',
      });
      children.push(child);
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(1);
      expect(stderr).toContain(`Olympus is running and owns its data at ${olympusDataRoot(env)}`);
      expect(stderr).toContain('olympus engine stop');
    }, 60_000);
  }
});
