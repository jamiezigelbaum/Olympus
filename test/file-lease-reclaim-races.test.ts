// Reclaiming an abandoned commit guard or lease must be atomic: an observer
// that judged a file abandoned may never delete a file it did not confirm.
// Each test runs another party's whole step in the window between the
// observer's decision and its action (the test-only fileLeaseTestHooks), the
// interleaving that used to admit two committers or delete a live lease.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  FileLeaseBusyError,
  fileLeaseTestHooks,
  isFileLeaseSidecarName,
  removeAbandonedLegacyCommitGuardSync,
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

  test('an abandoned bare guard is ignored, then removed only on request under the held guard', () => {
    const path = target();
    writeFileSync(`${path}.lock.commit`, record('older-engine', DEAD_PID), { mode: 0o600 });
    expect(withFileLeaseSync(path, (lease) => lease.commit(() => 'entered'), options)).toBe('entered');
    expect(existsSync(`${path}.lock.commit`)).toBe(true);
    withFileLeaseSync(path, (lease) => lease.commit(() => removeAbandonedLegacyCommitGuardSync(path)), options);
    expect(existsSync(`${path}.lock.commit`)).toBe(false);
  });

  test('a live bare guard is never removed', () => {
    const path = target();
    writeFileSync(`${path}.lock.commit`, record('older-engine', process.pid), { mode: 0o600 });
    removeAbandonedLegacyCommitGuardSync(path);
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
