// The run command's own argument rules: a harness commit is recorded, and one that is not the candidate's is refused up front.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseCli } from '../scripts/release-check/run.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function withConfig<T>(body: (args: string[]) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'rc-cli-test-'));
  try {
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ driver: ['/bin/true'] }));
    return body(['--config', config, '--candidate', dir, '--out', join(dir, 'out')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('release-check run command arguments', () => {
  test('a harness commit is carried into the options; none means an unpinned run', () => {
    withConfig((base) => {
      expect(parseCli([...base, '--sha', A, '--harness-commit', A]).harnessCommit).toBe(A);
      expect(parseCli([...base, '--harness-commit', B]).harnessCommit).toBe(B);
      expect(parseCli(base).harnessCommit).toBeUndefined();
    });
  });

  test('a harness commit that is not the candidate\'s sha, or not a full commit, is refused before anything starts', () => {
    withConfig((base) => {
      expect(() => parseCli([...base, '--sha', A, '--harness-commit', B])).toThrow("is not the candidate's --sha");
      expect(() => parseCli([...base, '--harness-commit', 'abc123'])).toThrow('40-character');
    });
  });
});
