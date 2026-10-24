// The test preload (test/support/isolated-home.ts) is what keeps every test
// off the owner's real data. These pin the parts a test can bypass by
// accident: a run that starts outside a throwaway home, a child process that
// names its own environment, and a child pointed at the real home under
// another spelling. A broken preload fails here, not by writing into a live
// store (2026-10-23).

import { describe, expect, test } from 'bun:test';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const isolatedHome = process.env.OLYMPUS_TEST_ISOLATED_HOME ?? '';
const realHome = process.env.OLYMPUS_TEST_REAL_HOME ?? '';
const printHome = ['-c', 'printf %s "$HOME"'];
const repoRoot = join(import.meta.dir, '..');
// Selects no test, so a child run executes no test code even if its preload
// failed to refuse it.
const NO_TEST = '^no test is named this$';
const PROBE_TEST = 'probe: the account home resolves without USER or LOGNAME';

describe('isolated HOME preload', () => {
  test('the test process runs in a throwaway home', () => {
    expect(isolatedHome).not.toBe('');
    expect(process.env.HOME).toBe(isolatedHome);
    expect(homedir()).toBe(isolatedHome);
    if (realHome) expect(isolatedHome).not.toBe(realHome);
  });

  test('a run that starts in a refused home is stopped before any test runs, under any spelling', () => {
    // A stand-in for the real home: the refusal is proven without ever
    // starting a run there.
    const standIn = mkdtempSync(join(isolatedHome, 'stand-in-home-'));
    const alias = join(isolatedHome, 'alias-of-stand-in');
    symlinkSync(standIn, alias);
    for (const spelling of [standIn, `${standIn}/`, alias]) {
      const run = Bun.spawnSync([process.execPath, 'test', '--test-name-pattern', NO_TEST, 'test/isolated-home-preload.test.ts'], {
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? '', HOME: spelling, OLYMPUS_TEST_REFUSE_HOME: standIn },
      });
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr.toString()).toContain(`Refusing to run tests with HOME=${realpathSync(standIn)}`);
    }
  });

  test('the account home is found from the uid, not from USER or LOGNAME', () => {
    if (!realHome) return; // no user database entry to find (bare container user)
    const run = Bun.spawnSync([process.execPath, 'test', '--test-name-pattern', PROBE_TEST, 'test/isolated-home-preload.test.ts'], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? '', HOME: isolatedHome, ISOLATED_HOME_PROBE: realHome },
    });
    expect(run.stderr.toString()).toContain('1 pass');
    expect(run.exitCode).toBe(0);
  });

  test(PROBE_TEST, () => {
    // Runs only inside the child above, which starts without USER or LOGNAME.
    const expected = process.env.ISOLATED_HOME_PROBE;
    if (!expected) return;
    expect(process.env.USER).toBeUndefined();
    expect(process.env.LOGNAME).toBeUndefined();
    expect(realHome).toBe(expected);
  });

  test('a child given an environment without HOME gets the isolated home', () => {
    const viaNode = spawnSync('/bin/sh', printHome, { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(viaNode.stdout).toBe(isolatedHome);
    const viaBun = Bun.spawnSync(['/bin/sh', ...printHome], { env: { PATH: process.env.PATH ?? '' } });
    expect(viaBun.stdout.toString()).toBe(isolatedHome);
  });

  test('promisified execFile keeps its { stdout, stderr } result', async () => {
    const result = await promisify(execFile)('/bin/sh', printHome, { env: { PATH: process.env.PATH } });
    expect(result.stdout).toBe(isolatedHome);
  });

  test('a child asked to run with the real home is refused before it starts, under any spelling', () => {
    if (!realHome) return; // no user database entry to refuse (bare container user)
    const alias = join(isolatedHome, 'alias-of-real-home');
    symlinkSync(realHome, alias);
    for (const spelling of [realHome, `${realHome}/`, `${realHome}/./`, alias]) {
      const env = { PATH: process.env.PATH ?? '', HOME: spelling };
      expect(() => spawnSync('/bin/sh', printHome, { env })).toThrow(/real HOME/);
      expect(() => Bun.spawnSync(['/bin/sh', ...printHome], { env })).toThrow(/real HOME/);
    }
  });
});
