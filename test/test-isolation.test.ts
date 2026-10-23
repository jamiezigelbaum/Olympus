import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
});
