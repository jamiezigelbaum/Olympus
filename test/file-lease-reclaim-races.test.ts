// Reclaiming an abandoned commit guard or lease must be atomic: an observer
// that judged a file abandoned may never delete a file it did not confirm.
// Each test runs another party's whole step in the window between the
// observer's decision and its action (the test-only fileLeaseTestHooks), the
// interleaving that used to admit two committers or delete a live lease.

import { closeSync, existsSync, mkdtempSync, openSync, unlinkSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  FileLeaseBusyError,
  fileLeaseTestHooks,
  isFileLeaseSidecarName,
  withFileLease,
  withFileLeaseSync,
} from '../src/core/file-lease.ts';

const roots: string[] = [];
afterEach(() => {
  delete fileLeaseTestHooks.afterGuardJudgedAbandoned;
  delete fileLeaseTestHooks.afterLeaseJudgedStale;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DEAD_PID = 2_147_483_000;
const record = (token: string, pid: number) => JSON.stringify({
  version: 1, token, pid, acquiredAt: new Date().toISOString(),
});
const options = { acquireTimeoutMs: 120, pollIntervalMs: 10, staleAfterMs: Number.MAX_SAFE_INTEGER, heartbeatIntervalMs: 60_000 };

function target(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-lease-races-'));
  roots.push(root);
  return join(root, 'state.json');
}

function tokenIn(path: string): string | undefined {
  return JSON.parse(readFileSync(path, 'utf8')).token;
}

describe('commit guard reclamation', () => {
  // B and A both judge the dead guard D abandoned. A completes its takeover
  // (claims the next number and is now inside its guarded region) before B
  // acts. B must not touch A's guard and must not become a second committer.
  function interleaveSecondClaimant(path: string): void {
    let fired = false;
    fileLeaseTestHooks.afterGuardJudgedAbandoned = () => {
      if (fired) return;
      fired = true;
      writeFileSync(`${path}.lock.commit.2`, record('A-live-guard', process.pid), { mode: 0o600 });
    };
  }

  test('async: a stale observer cannot delete a replacement guard or commit beside it', async () => {
    const path = target();
    await withFileLease(path, async (lease) => {
      writeFileSync(`${path}.lock.commit.1`, record('D-dead-guard', DEAD_PID), { mode: 0o600 });
      interleaveSecondClaimant(path);
      let entered = false;
      await expect(lease.commit(async () => { entered = true; })).rejects.toBeInstanceOf(FileLeaseBusyError);
      expect(entered).toBe(false);
      expect(tokenIn(`${path}.lock.commit.2`)).toBe('A-live-guard');
      rmSync(`${path}.lock.commit.2`); // A leaves its guarded region
    }, options);
  });

  test('sync: a stale observer cannot delete a replacement guard or commit beside it', () => {
    const path = target();
    withFileLeaseSync(path, (lease) => {
      writeFileSync(`${path}.lock.commit.1`, record('D-dead-guard', DEAD_PID), { mode: 0o600 });
      interleaveSecondClaimant(path);
      let entered = false;
      expect(() => lease.commit(() => { entered = true; })).toThrow(FileLeaseBusyError);
      expect(entered).toBe(false);
      expect(tokenIn(`${path}.lock.commit.2`)).toBe('A-live-guard');
      rmSync(`${path}.lock.commit.2`); // A leaves its guarded region
    }, options);
  });

  test('an abandoned guard is superseded and the new guard is released cleanly', async () => {
    const path = target();
    writeFileSync(`${path}.lock.commit.1`, record('D-dead-guard', DEAD_PID), { mode: 0o600 });
    await withFileLease(path, async (lease) => {
      expect(await lease.commit(async () => 'committed')).toBe('committed');
    }, options);
    // Only the crashed holder's file remains; nothing of this run's.
    expect(readdirSync(join(path, '..')).filter((n) => n.includes('.commit'))).toEqual(['state.json.lock.commit.1']);
  });

  test('concurrent acquirers never overlap, even across a crashed guard', async () => {
    const path = target();
    writeFileSync(`${path}.lock.commit.1`, record('D-dead-guard', DEAD_PID), { mode: 0o600 });
    writeFileSync(`${path}.lock`, record('dead-owner', DEAD_PID), { mode: 0o600 });
    let inside = 0;
    let maxInside = 0;
    const wide = { ...options, acquireTimeoutMs: 5_000 };
    await Promise.all(Array.from({ length: 12 }, async () => {
      await withFileLease(path, async (lease) => {
        await lease.commit(async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await Bun.sleep(2);
          inside -= 1;
        });
        await Bun.sleep(2);
      }, wide);
    }));
    expect(maxInside).toBe(1);
  });
});

describe('empty-record lease reclamation', () => {
  // A foreign writer created the lock and has not written its record yet; the
  // file is old enough to look abandoned. It then writes a valid record before
  // the observer confirms. The observer must leave the now-valid lease alone.
  function emptyOldLock(path: string): void {
    writeFileSync(`${path}.lock`, '', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    let fired = false;
    fileLeaseTestHooks.afterLeaseJudgedStale = () => {
      if (fired) return;
      fired = true;
      writeFileSync(`${path}.lock`, record('A-live-lease', process.pid), { mode: 0o600 });
    };
  }
  const aging = { ...options, staleAfterMs: 1_000 };

  test('async: a creator that finishes writing keeps its lease', async () => {
    const path = target();
    emptyOldLock(path);
    await expect(withFileLease(path, async () => 'stolen', aging)).rejects.toBeInstanceOf(FileLeaseBusyError);
    expect(tokenIn(`${path}.lock`)).toBe('A-live-lease');
  });

  test('sync: a creator that finishes writing keeps its lease', () => {
    const path = target();
    emptyOldLock(path);
    expect(() => withFileLeaseSync(path, () => 'stolen', aging)).toThrow(FileLeaseBusyError);
    expect(tokenIn(`${path}.lock`)).toBe('A-live-lease');
  });

  test('an empty lock that stays empty is still reclaimed after the stale bound', async () => {
    const path = target();
    writeFileSync(`${path}.lock`, '', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    await expect(withFileLease(path, async () => 'taken', aging)).resolves.toBe('taken');
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test('a lease is never visible empty to an observer: it is published whole', async () => {
    const path = target();
    await withFileLease(path, async () => {
      expect(readFileSync(`${path}.lock`, 'utf8').length).toBeGreaterThan(0);
      expect(readdirSync(join(path, '..')).filter((n) => n.includes('.tmp-'))).toEqual([]);
    }, options);
  });
});

describe('an engine from before the numbered guard series', () => {
  test('a live bare guard still excludes a commit', () => {
    const path = target();
    writeFileSync(`${path}.lock.commit`, record('older-engine', process.pid), { mode: 0o600 });
    expect(() => withFileLeaseSync(path, (lease) => lease.commit(() => 'entered'), options)).toThrow(FileLeaseBusyError);
    expect(tokenIn(`${path}.lock.commit`)).toBe('older-engine');
  });

  test('an abandoned bare guard is removed by the claim that supersedes it, and nothing is left', () => {
    const path = target();
    writeFileSync(`${path}.lock.commit`, record('older-engine', DEAD_PID), { mode: 0o600 });
    expect(withFileLeaseSync(path, (lease) => lease.commit(() => 'entered'), options)).toBe('entered');
    expect(existsSync(`${path}.lock.commit`)).toBe(false);
  });

  test('async: a live bare guard excludes; an abandoned one does not', async () => {
    const path = target();
    writeFileSync(`${path}.lock.commit`, record('older-engine', process.pid), { mode: 0o600 });
    await withFileLease(path, async (lease) => {
      await expect(lease.commit(async () => 'entered')).rejects.toBeInstanceOf(FileLeaseBusyError);
      // The failed claim released its numbered guard again.
      expect(existsSync(`${path}.lock.commit.1`)).toBe(false);
      writeFileSync(`${path}.lock.commit`, record('older-engine', DEAD_PID), { mode: 0o600 });
      expect(await lease.commit(async () => 'entered')).toBe('entered');
    }, options);
    expect(existsSync(`${path}.lock.commit`)).toBe(false);
  });

  test('while a current holder is inside its region the bare name is held, so an older engine waits', () => {
    const path = target();
    withFileLeaseSync(path, (lease) => lease.commit(() => {
      const bare = tokenIn(`${path}.lock.commit`);
      expect(bare).toBeDefined();
      // The older engine's own claim is an exclusive create of the bare name.
      expect(() => writeFileSync(`${path}.lock.commit`, 'x', { flag: 'wx' })).toThrow();
      expect(tokenIn(`${path}.lock.commit`)).toBe(bare);
    }), options);
    expect(existsSync(`${path}.lock.commit`)).toBe(false);
  });

  test('a live bare guard is never removed', () => {
    const path = target();
    writeFileSync(`${path}.lock.commit`, record('older-engine', process.pid), { mode: 0o600 });
    expect(() => withFileLeaseSync(path, (lease) => lease.commit(() => 'entered'), options)).toThrow(FileLeaseBusyError);
    expect(tokenIn(`${path}.lock.commit`)).toBe('older-engine');
  });

  test('inventories recognize every lease file and nothing else', () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    for (const name of ['state.json.lock', 'state.json.lock.commit', 'state.json.lock.commit.1', 'state.json.lock.commit.42',
      `state.json.lock.tmp-${uuid}`, `state.json.lock.commit.3.tmp-${uuid}`]) expect(isFileLeaseSidecarName('state.json', name)).toBe(true);
    for (const name of ['state.json', 'state.json.lock.commit.0', 'state.json.lock.commit.x', 'state.json.lock.old',
      'other.json.lock', 'state.json.lock.commit.1.tmp-nope', 'state.jsonx.lock']) expect(isFileLeaseSidecarName('state.json', name)).toBe(false);
  });
});

describe('a superseded guard is retired, not left able to read as live', () => {
  test('claiming over an abandoned guard rewrites it as retired; a retired guard is not busy', async () => {
    const path = target();
    writeFileSync(`${path}.lock.commit.1`, record('D-dead-guard', DEAD_PID), { mode: 0o600 });
    await withFileLease(path, async (lease) => {
      expect(await lease.commit(async () => 'a')).toBe('a');
      // The abandoned file is still there (gapless) but no longer a record of any process.
      const retired = JSON.parse(readFileSync(`${path}.lock.commit.1`, 'utf8'));
      expect(retired).toEqual({ version: 1, retired: true });
      expect(existsSync(`${path}.lock.commit.2`)).toBe(false);
      expect(await lease.commit(async () => 'b')).toBe('b');
    }, options);
  });

  test('a retired guard stays harmless even if its old PID is now a live process', () => {
    const path = target();
    // What the retired file replaced named this very (live) process.
    writeFileSync(`${path}.lock.commit.1`, JSON.stringify({ version: 1, retired: true }), { mode: 0o600 });
    withFileLeaseSync(path, (lease) => {
      expect(lease.commit(() => 'entered')).toBe('entered');
    }, options);
  });
});

describe('a filesystem without hard links', () => {
  const refuse = (code: string) => (): never => {
    throw Object.assign(new Error(`link refused: ${code}`), { code });
  };
  for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) {
    test(`${code}: leases and commits fall back to exclusive creation`, async () => {
      const path = target();
      fileLeaseTestHooks.link = refuse(code);
      try {
        await withFileLease(path, async (lease) => {
          expect(await lease.commit(async () => 'async')).toBe('async');
          // Exclusion still holds: a second claimant is busy.
          await expect(withFileLease(path, async () => 'x', { ...options, acquireTimeoutMs: 30 }))
            .rejects.toBeInstanceOf(FileLeaseBusyError);
        }, options);
        withFileLeaseSync(path, (lease) => expect(lease.commit(() => 'sync')).toBe('sync'), options);
      } finally {
        delete fileLeaseTestHooks.link;
      }
      expect(readdirSync(join(path, '..'))).toEqual([]);
    });
  }

  test('any other link error is still an error, not a silent fallback', () => {
    const path = target();
    fileLeaseTestHooks.link = refuse('EIO');
    try {
      expect(() => withFileLeaseSync(path, () => 'x', options)).toThrow('link refused: EIO');
    } finally {
      delete fileLeaseTestHooks.link;
    }
  });
});

describe('an older-protocol contender and current holders', () => {
  test('never inside their guarded regions together', async () => {
    const path = target();
    let inside = 0;
    let maxInside = 0;
    const enter = async (): Promise<void> => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await Bun.sleep(2);
      inside -= 1;
    };
    // The older protocol: exclusive-create the bare name, write the record, run, unlink.
    const older = async (): Promise<void> => {
      for (let done = 0; done < 15;) {
        let descriptor: number;
        try {
          descriptor = openSync(`${path}.lock.commit`, 'wx', 0o600);
        } catch {
          await Bun.sleep(1);
          continue;
        }
        writeFileSync(descriptor, record('older-engine', process.pid));
        closeSync(descriptor);
        await enter();
        unlinkSync(`${path}.lock.commit`);
        done += 1;
      }
    };
    const current = async (): Promise<void> => {
      await withFileLease(path, async (lease) => {
        for (let i = 0; i < 15; i += 1) await lease.commit(enter);
      }, { ...options, acquireTimeoutMs: 20_000, pollIntervalMs: 1 });
    };
    await Promise.all([older(), current()]);
    expect(maxInside).toBe(1);
  }, 30_000);
});

describe('a long guarded section (the Linux upgrade holds the guard across pre-stop work)', () => {
  test('neither an older nor a current writer can judge the held lease stale and take it', () => {
    const path = target();
    const stale = { ...options, acquireTimeoutMs: 40, pollIntervalMs: 5, staleAfterMs: 50 };
    withFileLeaseSync(path, (lease) => lease.commit(() => {
      // The section outlives the stale threshold: the lock looks old, with no heartbeat.
      const old = new Date(Date.now() - 60_000);
      utimesSync(`${path}.lock`, old, old);
      const owner = tokenIn(`${path}.lock`);
      // An older writer must hold the bare name to reclaim a lock; it is taken.
      expect(() => writeFileSync(`${path}.lock.commit`, 'x', { flag: 'wx' })).toThrow();
      // A current writer must hold the numbered guard; it is busy, not a takeover.
      expect(() => withFileLeaseSync(path, () => 'taken', stale)).toThrow(FileLeaseBusyError);
      expect(tokenIn(`${path}.lock`)).toBe(owner);
    }), { ...stale, acquireTimeoutMs: 1_000 });
  });
});
