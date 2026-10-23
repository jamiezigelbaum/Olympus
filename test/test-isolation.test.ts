import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { spawn, spawnSync, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, relative } from 'node:path';
import { lifecycleSourceSpecs } from '../src/data-lifecycle.ts';
import { defaultHandleRegistryPath } from '../src/workers/credential-broker/connected-handles.ts';

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

describe('tests never touch the real home', () => {
  test('HOME, the XDG tree and the default data and config paths resolve inside the throwaway home', () => {
    const real = process.env.OLYMPUS_TEST_REAL_HOME!;
    expect(homedir()).not.toBe(real);
    expect(homedir()).toBe(process.env.OLYMPUS_TEST_ISOLATED_HOME!);
    expect(inside(realpathSync(tmpdir()), homedir())).toBe(true);
    expect(inside(homedir(), defaultHandleRegistryPath())).toBe(true);
    for (const spec of lifecycleSourceSpecs()) {
      for (const path of spec.connectorStorePaths?.({ env: {} }) ?? []) {
        expect(inside(homedir(), path)).toBe(true);
      }
    }
  });

  const PRINT_HOME = 'import { homedir } from "node:os"; console.log(homedir());';

  test('a child whose env names no HOME gets the throwaway home, for every spawn flavour', async () => {
    const isolated = process.env.OLYMPUS_TEST_ISOLATED_HOME!;
    const env = { PATH: process.env.PATH! };
    expect(spawnSync(process.execPath, ['-e', PRINT_HOME], { env, encoding: 'utf8' }).stdout.trim()).toBe(isolated);
    expect(execFileSync(process.execPath, ['-e', PRINT_HOME], { env, encoding: 'utf8' }).trim()).toBe(isolated);
    const viaBun = Bun.spawnSync([process.execPath, '-e', PRINT_HOME], { env });
    expect(new TextDecoder().decode(viaBun.stdout).trim()).toBe(isolated);
    const child = spawn(process.execPath, ['-e', PRINT_HOME], { env });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    await new Promise((resolve) => child.on('exit', resolve));
    expect(out.trim()).toBe(isolated);
    // An env object with no prototype is an environment too.
    const bare = Object.create(null) as Record<string, string>;
    bare.PATH = process.env.PATH!;
    expect(spawnSync(process.execPath, ['-e', PRINT_HOME], { env: bare, encoding: 'utf8' }).stdout.trim()).toBe(isolated);
    expect(new TextDecoder().decode(Bun.spawnSync([process.execPath, '-e', PRINT_HOME], { env: bare }).stdout).trim()).toBe(isolated);
  }, 10_000);

  test('promisified execFile keeps its { stdout, stderr } result and the isolated HOME', async () => {
    const result = await promisify(execFile)(process.execPath, ['-e', PRINT_HOME], { env: { PATH: process.env.PATH! }, encoding: 'utf8' });
    expect(result.stdout.trim()).toBe(process.env.OLYMPUS_TEST_ISOLATED_HOME!);
  }, 10_000);

  test('a child asked to run against the real home is refused', () => {
    const real = process.env.OLYMPUS_TEST_REAL_HOME!;
    // A bare container user has no resolvable account home: nothing to refuse.
    if (!real) return;
    expect(() => spawnSync(process.execPath, ['-e', '1'], { env: { PATH: process.env.PATH!, HOME: real } })).toThrow(/real HOME/);
    expect(() => Bun.spawnSync([process.execPath, '-e', '1'], { env: { PATH: process.env.PATH!, HOME: real } })).toThrow(/real HOME/);
    const bare = Object.create(null) as Record<string, string>;
    bare.HOME = real;
    expect(() => spawnSync(process.execPath, ['-e', '1'], { env: bare })).toThrow(/real HOME/);
  }, 10_000);

  test('the whole run started under an isolated HOME, so descendants cannot inherit the real one', () => {
    expect(process.env.HOME).toBe(process.env.OLYMPUS_TEST_ISOLATED_HOME!);
    // A child started with the process environment sees the isolated home.
    const inherited = spawnSync(process.execPath, ['-e', PRINT_HOME], { encoding: 'utf8' }).stdout.trim();
    expect(inherited).not.toBe(process.env.OLYMPUS_TEST_REAL_HOME!);
    expect(inherited.startsWith(realpathSync(tmpdir())) || inherited.startsWith(tmpdir())).toBe(true);
  }, 10_000);
});
