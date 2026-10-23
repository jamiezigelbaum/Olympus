// The lease is a lock the operating system holds for the holder. These tests
// prove the properties that follow from that, with real processes under both
// runtimes that load the module: Bun, and Node (OpenClaw's plugin host).
// Spawning tests carry an explicit timeout (test/spawn-timeout-guard.test.ts).

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  FileLeaseBusyError,
  FileLeaseLostError,
  isFileLeaseSidecarName,
  withFileLease,
  withFileLeaseSync,
} from '../src/core/file-lease.ts';

const roots: string[] = [];
const children: Array<{ kill(signal?: number | NodeJS.Signals): void }> = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MODULE = join(import.meta.dir, '..', 'src', 'core', 'file-lease.ts');
const NODE = Bun.which('node');
const fast = { acquireTimeoutMs: 60, pollIntervalMs: 5 };

function target(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-kernel-lease-'));
  roots.push(root);
  return join(root, 'state.json');
}

const holderScript = (path: string, mode: 'sync' | 'async') => `
import { withFileLease, withFileLeaseSync } from ${JSON.stringify(MODULE)};
const hold = () => new Promise(() => setInterval(() => {}, 1000));
if (${JSON.stringify(mode)} === 'sync') {
  withFileLeaseSync(${JSON.stringify(path)}, () => { process.stdout.write('HELD\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); });
} else {
  await withFileLease(${JSON.stringify(path)}, async () => { process.stdout.write('HELD\\n'); await hold(); });
}
`;

async function startHolder(runtime: string, path: string, mode: 'sync' | 'async') {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-kernel-holder-'));
  roots.push(dir);
  const script = join(dir, 'holder.mts');
  await Bun.write(script, holderScript(path, mode));
  const child = Bun.spawn([runtime, script], { stdout: 'pipe', stderr: 'pipe' });
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

const runtimes: Array<[string, string | null | undefined]> = [['bun', process.execPath], ['node', NODE]];

describe('a kernel-held lease across processes', () => {
  for (const [name, runtime] of runtimes) {
    for (const mode of ['sync', 'async'] as const) {
      test(`${name} holder (${mode}): a contender is busy, and a SIGKILLed holder is released at once`, async () => {
        if (!runtime) return; // no Node on this machine; the Bun leg still runs
        const path = target();
        for (let round = 0; round < 3; round += 1) {
          const holder = await startHolder(runtime, path, mode);
          await expect(withFileLease(path, async () => 'x', fast)).rejects.toBeInstanceOf(FileLeaseBusyError);
          expect(() => withFileLeaseSync(path, () => 'x', fast)).toThrow(FileLeaseBusyError);
          holder.kill('SIGKILL');
          await holder.exited;
          // No staleness bound, no PID judgement: the very next attempt succeeds.
          const started = Date.now();
          expect(await withFileLease(path, async () => 'taken', { acquireTimeoutMs: 2_000, pollIntervalMs: 5 })).toBe('taken');
          expect(Date.now() - started).toBeLessThan(1_000);
        }
      }, 10_000);
    }
  }

  test('a live holder is never judged stale, however old the lease is', async () => {
    const path = target();
    const holder = await startHolder(process.execPath, path, 'async');
    await Bun.sleep(150);
    await expect(withFileLease(path, async () => 'x', { ...fast, staleAfterMs: 1, heartbeatIntervalMs: 1 }))
      .rejects.toBeInstanceOf(FileLeaseBusyError);
    holder.kill('SIGKILL');
    await holder.exited;
  }, 10_000);
});

describe('a kernel-held lease within one process', () => {
  test('async: a second lease on the same target is busy until the first releases', async () => {
    const path = target();
    await withFileLease(path, async () => {
      await expect(withFileLease(path, async () => 'x', fast)).rejects.toBeInstanceOf(FileLeaseBusyError);
    });
    expect(await withFileLease(path, async () => 'free')).toBe('free');
  });

  test('sync: a second lease on the same target is busy until the first releases', () => {
    const path = target();
    withFileLeaseSync(path, () => {
      expect(() => withFileLeaseSync(path, () => 'x', fast)).toThrow(FileLeaseBusyError);
    });
    expect(withFileLeaseSync(path, () => 'free')).toBe('free');
  });

  test('the lease is released when the callback throws', async () => {
    const path = target();
    await expect(withFileLease(path, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(() => withFileLeaseSync(path, () => { throw new Error('boom'); })).toThrow('boom');
    expect(await withFileLease(path, async () => 'free')).toBe('free');
  });

  test('commit runs the write while held; a released lease refuses with a typed error', async () => {
    const path = target();
    let kept!: Parameters<Parameters<typeof withFileLease>[1]>[0];
    expect(await withFileLease(path, async (lease) => {
      kept = lease;
      await lease.assertOwned();
      return lease.commit(async () => 'written');
    })).toBe('written');
    await expect(kept.assertOwned()).rejects.toBeInstanceOf(FileLeaseLostError);
    await expect(kept.commit(async () => 'late')).rejects.toBeInstanceOf(FileLeaseLostError);
  });

  test('the lock database is private, persists between uses, and is the only file', async () => {
    const path = target();
    await withFileLease(path, async (lease) => {
      expect(lease.lockPath).toBe(`${path}.lock.db`);
      expect(statSync(lease.lockPath).mode & 0o077).toBe(0);
    });
    expect(existsSync(`${path}.lock.db`)).toBe(true);
  });
});

describe('lease file names', () => {
  test('inventories recognize the lock database and the files older engines left, and nothing else', () => {
    for (const name of ['state.json.lock.db', 'state.json.lock.db-journal', 'state.json.lock', 'state.json.lock.commit', 'state.json.lock.commit.7'])
      expect(isFileLeaseSidecarName('state.json', name)).toBe(true);
    for (const name of ['state.json', 'state.json.lock.dbx', 'state.json.lock.old', 'other.json.lock.db', 'state.jsonx.lock.db', 'state.json.lock.commit.0'])
      expect(isFileLeaseSidecarName('state.json', name)).toBe(false);
  });
});
