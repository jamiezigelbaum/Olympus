import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { refusalMessage, scanAddedDiff } from '../scripts/credential-pattern-check.ts';

const ROOT = join(import.meta.dir, '..');

describe('credential pattern check', () => {
  test('reports only the file and credential class for added material', () => {
    const credential = 'AKIA' + 'A'.repeat(16);
    const findings = scanAddedDiff([
      'diff --git a/config.ts b/config.ts',
      '+++ b/config.ts',
      `+export const value = "${credential}";`,
    ].join('\n'));

    expect(findings).toEqual([{ file: 'config.ts', kinds: ['aws_access_key'] }]);
    expect(refusalMessage(findings)).not.toContain(credential);
  }, 10_000);

  test('ignores context and removed credentials', () => {
    const credential = 'gh' + 'p_' + 'A'.repeat(30);
    const findings = scanAddedDiff([
      'diff --git a/config.ts b/config.ts',
      '--- a/config.ts',
      '+++ b/config.ts',
      `-${credential}`,
      ` ${credential}`,
      '+safe replacement',
    ].join('\n'));
    expect(findings).toEqual([]);
  }, 10_000);

  test('deduplicates classes without printing matched material', () => {
    const privateKey = '-----BEGIN ' + 'PRIVATE KEY-----';
    const googleKey = 'AIza' + 'A'.repeat(35);
    const findings = scanAddedDiff([
      '+++ b/secret.txt',
      `+${privateKey}`,
      `+${googleKey}`,
      `+${googleKey}`,
    ].join('\n'));
    expect(findings).toEqual([{
      file: 'secret.txt',
      kinds: ['google_api_key', 'private_key'],
    }]);
    expect(refusalMessage(findings)).not.toContain(privateKey);
    expect(refusalMessage(findings)).not.toContain(googleKey);
  }, 10_000);

  test('forces text diff semantics despite untrusted attributes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'olympus-credential-diff-test-'));
    try {
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'test@example.invalid']);
      git(repo, ['config', 'user.name', 'Olympus Test']);
      writeFileSync(join(repo, 'base.txt'), 'base\n');
      git(repo, ['add', 'base.txt']);
      git(repo, ['commit', '-m', 'base']);
      const base = git(repo, ['rev-parse', 'HEAD']).trim();

      const credential = 'AKIA' + 'A'.repeat(16);
      writeFileSync(join(repo, '.gitattributes'), 'secret.txt -diff\n');
      writeFileSync(join(repo, 'secret.txt'), `${credential}\n`);
      git(repo, ['add', '.gitattributes', 'secret.txt']);
      git(repo, ['commit', '-m', 'attempt hidden credential']);
      const head = git(repo, ['rev-parse', 'HEAD']).trim();

      const result = Bun.spawnSync([
        'bun',
        join(ROOT, 'scripts', 'credential-pattern-check.ts'),
        '--base',
        base,
        '--head',
        head,
      ], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('aws_access_key');
      expect(result.stderr.toString()).not.toContain(credential);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 10_000);

  test('scans only pull-request additions from the merge base', () => {
    const repo = mkdtempSync(join(tmpdir(), 'olympus-credential-merge-base-'));
    try {
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'test@example.invalid']);
      git(repo, ['config', 'user.name', 'Olympus Test']);
      writeFileSync(join(repo, 'base.txt'), 'base\n');
      git(repo, ['add', 'base.txt']);
      git(repo, ['commit', '-m', 'base']);
      const mergeBase = git(repo, ['rev-parse', 'HEAD']).trim();

      git(repo, ['switch', '-q', '-c', 'feature']);
      writeFileSync(join(repo, 'feature.txt'), 'safe feature line\n');
      git(repo, ['add', 'feature.txt']);
      git(repo, ['commit', '-m', 'feature']);
      const head = git(repo, ['rev-parse', 'HEAD']).trim();

      git(repo, ['switch', '-q', 'main']);
      const credential = 'AKIA' + 'A'.repeat(16);
      writeFileSync(join(repo, 'base.txt'), `${credential}\n`);
      git(repo, ['add', 'base.txt']);
      git(repo, ['commit', '-m', 'base moved']);
      const currentBase = git(repo, ['rev-parse', 'HEAD']).trim();
      expect(currentBase).not.toBe(mergeBase);

      const result = Bun.spawnSync([
        'bun', join(ROOT, 'scripts', 'credential-pattern-check.ts'),
        '--base', currentBase, '--head', head,
      ], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('no high-confidence credential patterns');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 10_000);
});

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
