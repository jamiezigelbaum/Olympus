// The test preload (test/support/isolated-home.ts) is what keeps every test
// off the owner's real data. These pin the parts a test can bypass by
// accident: a child process that names its own environment, and a child
// pointed at the real home. A broken preload fails here, not by writing into
// a live store (2026-10-23).

import { describe, expect, test } from 'bun:test';
import { execFile, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const isolatedHome = process.env.OLYMPUS_TEST_ISOLATED_HOME ?? '';
const realHome = process.env.OLYMPUS_TEST_REAL_HOME ?? '';
const printHome = ['-c', 'printf %s "$HOME"'];

describe('isolated HOME preload', () => {
  test('the test process runs in a throwaway home', () => {
    expect(isolatedHome).not.toBe('');
    expect(process.env.HOME).toBe(isolatedHome);
    expect(homedir()).toBe(isolatedHome);
    if (realHome) expect(isolatedHome).not.toBe(realHome);
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

  test('a child asked to run with the real home is refused before it starts', () => {
    if (!realHome) return; // no resolvable account home to refuse (bare container user)
    expect(() => spawnSync('/bin/sh', printHome, { env: { PATH: process.env.PATH, HOME: realHome } })).toThrow(
      /real HOME/,
    );
    expect(() => Bun.spawnSync(['/bin/sh', ...printHome], { env: { PATH: process.env.PATH ?? '', HOME: realHome } })).toThrow(
      /real HOME/,
    );
  });
});
