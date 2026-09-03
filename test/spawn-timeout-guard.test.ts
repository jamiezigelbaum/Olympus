import { Glob } from 'bun';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanSpawningTests } from './helpers/spawn-timeout-audit.ts';

const repoRoot = join(import.meta.dir, '..');

test('subprocess-spawning tests declare an explicit per-test timeout', () => {
  const offenders = [...new Glob('test/**/*.{test,spec}.{ts,tsx}').scanSync({ cwd: repoRoot })]
    .flatMap((relativePath) => {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8');
      return scanSpawningTests(relativePath, source)
        .filter((entry) => !entry.hasExplicitTimeout)
        .map((entry) => `${relativePath}:${entry.line}: "${entry.name}"`);
    })
    .sort();

  expect(offenders).toEqual([]);
}, 30_000);

test('spawn audit follows local helper calls and ignores unrelated exec methods', () => {
  const source = `
    import * as childProcess from 'node:child_process';
    const runFixture = () => childProcess.spawnSync(['bash', 'fixture.sh']);
    test('helper spawn', () => withTemporaryHome(() => runFixture()));
    test('database exec', () => db.exec('SELECT 1'));
  `;

  expect(scanSpawningTests('test/fixture.test.ts', source).map((entry) => entry.name))
    .toEqual(['helper spawn']);
});
