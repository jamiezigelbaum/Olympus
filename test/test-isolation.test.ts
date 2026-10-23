import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
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
    expect(real).toBeTruthy();
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
  });

  test('a child asked to run against the real home is refused', () => {
    const real = process.env.OLYMPUS_TEST_REAL_HOME!;
    expect(() => spawnSync(process.execPath, ['-e', '1'], { env: { PATH: process.env.PATH!, HOME: real } })).toThrow(/real HOME/);
    expect(() => Bun.spawnSync([process.execPath, '-e', '1'], { env: { PATH: process.env.PATH!, HOME: real } })).toThrow(/real HOME/);
  });
});
