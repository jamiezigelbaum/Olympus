// A lease whose owner died is taken over by the next acquirer. When the
// takeover itself consumes the acquire timeout (a slow runner, or a commit
// guard that is briefly busy), the acquirer must still try the lease it just
// freed instead of reporting "busy" for a lease nobody holds. Admission must
// still never admit two holders: the freed lease is claimed with O_EXCL.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { FileLeaseBusyError, withFileLease, withFileLeaseSync } from '../src/core/file-lease.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const record = (token: string, pid: number) => JSON.stringify({
  version: 1, token, pid, acquiredAt: new Date().toISOString(),
});

function setup(): { target: string } {
  const root = mkdtempSync(join(tmpdir(), 'olympus-lease-deadline-'));
  roots.push(root);
  const target = join(root, 'state.json');
  // An owner pid that cannot exist, so the lease is recognisably abandoned.
  writeFileSync(`${target}.lock`, record('dead-owner', 2_147_483_000), { mode: 0o600 });
  // A live process briefly holds the commit guard, so the takeover waits one
  // poll interval, which is longer than the acquire timeout.
  writeFileSync(`${target}.lock.commit`, record('guard', process.pid), { mode: 0o600 });
  return { target };
}

const options = { acquireTimeoutMs: 50, pollIntervalMs: 120, staleAfterMs: Number.MAX_SAFE_INTEGER };

describe('file lease stale takeover vs acquire deadline', () => {
  test('async: a takeover that outlasts the timeout still claims the freed lease', async () => {
    const { target } = setup();
    setTimeout(() => rmSync(`${target}.lock.commit`, { force: true }), 20);
    await expect(withFileLease(target, async () => 'held', options)).resolves.toBe('held');
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test('sync: a takeover that outlasts the timeout still claims the freed lease', () => {
    const { target } = setup();
    const releaser = Bun.spawn(['/bin/sh', '-c', `sleep 0.02; rm -f '${target}.lock.commit'`]);
    expect(withFileLeaseSync(target, () => 'held', options)).toBe('held');
    releaser.kill();
  });

  test('a live holder is still refused as busy at the deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-lease-deadline-'));
    roots.push(root);
    const target = join(root, 'state.json');
    const fast = { ...options, pollIntervalMs: 10 };
    await withFileLease(target, async () => {
      await expect(withFileLease(target, async () => 'second', fast)).rejects.toBeInstanceOf(FileLeaseBusyError);
    }, fast);
  });
  test('owners that keep dying do not make the acquirer retry forever', async () => {
    const { target } = setup();
    rmSync(`${target}.lock.commit`, { force: true });
    // Another process keeps planting abandoned leases as fast as it can.
    const dead = record('dead-again', 2_147_483_000).replace(/'/g, '');
    const planter = Bun.spawn(['/bin/sh', '-c', `end=$(( $(date +%s) + 3 )); while [ $(date +%s) -lt $end ]; do printf '%s' '${dead}' > '${target}.lock'; done`]);
    const started = Date.now();
    const outcome = await withFileLease(target, async () => 'held', { acquireTimeoutMs: 50, pollIntervalMs: 5, staleAfterMs: Number.MAX_SAFE_INTEGER })
      .catch((error: unknown) => (error instanceof FileLeaseBusyError ? 'busy' : 'other'));
    planter.kill();
    // Either it won the race or it gave up; it never spins past the deadline.
    expect(['held', 'busy']).toContain(outcome);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
