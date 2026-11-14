// The upgrade holds the Linux unit stopped for its whole store copy. On the
// gate7 rc.11 legs (13 Nov) the engine was started again 15 s after the
// upgrade's stop and opened a store under the copy, which then refused it.
// The hold is a file the unit's ConditionPathExists names: while it is there,
// a start from anyone is skipped. The real systemd half of this is
// test/real-systemd-upgrade-hold.test.ts.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  holdLinuxWorkerStopped,
  installWorkerService,
  releaseAbandonedWorkerHold,
  workerServicePaths,
  workerUpgradeHoldPath,
  type WorkerServiceExec,
} from '../src/core/worker-service.ts';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-upgrade-hold-'));
  homes.push(dir);
  return dir;
}

function manager(showStates: string[]) {
  const calls: string[] = [];
  const exec: WorkerServiceExec = (command, args) => {
    const call = [command, ...args].join(' ');
    calls.push(call);
    if (args.includes('show')) {
      const state = showStates.length > 1 ? showStates.shift()! : showStates[0]!;
      return { status: 0, stdout: `ActiveState=${state}\nControlGroup=\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, exec };
}

describe('the upgrade hold', () => {
  test('the unit is skipped while the hold file is there', () => {
    const dir = home();
    const result = installWorkerService({ platform: 'linux', homeDir: dir, workingDirectory: process.cwd() });
    const hold = workerUpgradeHoldPath(workerServicePaths('linux', dir).unitPath);
    expect(readFileSync(result.unit_path, 'utf8')).toContain(`ConditionPathExists=!${hold}`);
  });

  test('writes the hold, reloads so the unit sees it, stops, and waits until nothing of the unit is left', () => {
    const dir = home();
    const { calls, exec } = manager(['deactivating', 'deactivating', 'inactive']);
    let slept = 0;
    const held = holdLinuxWorkerStopped({ homeDir: dir, exec, sleep: () => { slept += 1; } });
    const hold = workerUpgradeHoldPath(workerServicePaths('linux', dir).unitPath);
    expect(readFileSync(hold, 'utf8')).toBe(`${process.pid}\n`);
    expect(calls.slice(0, 2)).toEqual(['systemctl --user daemon-reload', 'systemctl --user stop olympus-worker.service']);
    expect(slept).toBe(2);
    held.release();
    expect(existsSync(hold)).toBe(false);
  });

  test('a unit that does not stop fails the upgrade before anything is copied, and lets the hold go', () => {
    const dir = home();
    const { exec } = manager(['active']);
    expect(() => holdLinuxWorkerStopped({ homeDir: dir, exec, timeoutMs: 0, sleep: () => {} }))
      .toThrow('Olympus did not stop for the upgrade: 1 of its processes are still running (the unit is active).');
    expect(existsSync(workerUpgradeHoldPath(workerServicePaths('linux', dir).unitPath))).toBe(false);
  });

  test('a hold whose upgrade died is let go by the next start; a live one is kept', () => {
    const dir = home();
    const hold = workerUpgradeHoldPath(workerServicePaths('linux', dir).unitPath);
    mkdirSync(dirname(hold), { recursive: true });
    // A pid no process has.
    writeFileSync(hold, '2147483646\n');
    releaseAbandonedWorkerHold(dir);
    expect(existsSync(hold)).toBe(false);
    // This process stands in for a running upgrade's.
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
    try {
      writeFileSync(hold, `${child.pid}\n`);
      releaseAbandonedWorkerHold(dir);
      expect(existsSync(hold)).toBe(true);
    } finally { child.kill(); }
  }, 20_000);
});
