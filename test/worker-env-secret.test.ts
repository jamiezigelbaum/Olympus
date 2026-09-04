/**
 * What Olympus is allowed to put into the file the worker's whole environment
 * comes from.
 *
 * The launchd unit sources worker.env with `set -a; . worker.env`, so every
 * byte written there is shell source text at every worker boot. An unquoted
 * value made an API key an injection point: a key pasted as `x$(touch …)` ran
 * that command as the owner, forever, on a schedule.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { unquoteEnvValue } from '../src/core/worker-auth.ts';
import { writeManagedWorkerEnvSecret } from '../src/core/worker-service.ts';

const KEY = 'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY';

/** Exactly how the launchd unit loads this file. */
function sourceValue(envPath: string): { status: number | null; stdout: string } {
  const result = spawnSync('/bin/sh', [
    '-c',
    `set -a; . ${JSON.stringify(envPath)}; set +a; printf %s "$${KEY}"`,
  ], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
}

describe('writing a secret into the managed worker environment', () => {
  test('a shell-metacharacter value is inert when the worker sources the file', () => {
    withEnvFile((dir, envPath) => {
      const marker = join(dir, 'PWNED');
      const hostile = `x$(touch ${marker})\`touch ${marker}\``;
      writeManagedWorkerEnvSecret({ key: KEY, value: hostile, envPath });

      // Single-quoted on disk, so the shell expands nothing inside it.
      expect(readFileSync(envPath, 'utf8')).toContain(`${KEY}='${hostile}'`);

      const sourced = sourceValue(envPath);
      expect(sourced.status).toBe(0);
      expect(sourced.stdout).toBe(hostile);
      expect(existsSync(marker)).toBe(false);
    });
  }, 30_000);

  test('a value carrying its own quote is refused, because the two parsers disagree', () => {
    withEnvFile((_dir, envPath) => {
      // Embedding a quote needs shell close-escape-reopen, and systemd's
      // EnvironmentFile parser does not implement that concatenation -- the
      // same bytes would reach a Linux worker as a different string from the
      // one /bin/sh reads. Refused at write time rather than stored as a
      // secret whose value depends on the platform.
      const before = readFileSync(envPath, 'utf8');
      expect(() => writeManagedWorkerEnvSecret({ key: KEY, value: "key-with-'-inside", envPath }))
        .toThrow('must not contain a single quote');
      expect(readFileSync(envPath, 'utf8')).toBe(before);
    });
  });

  test('what is written is read back identically by the shell and by Olympus', () => {
    withEnvFile((_dir, envPath) => {
      const key = 'gemini-Ab12_-key.value~x';
      writeManagedWorkerEnvSecret({ key: KEY, value: key, envPath });

      expect(sourceValue(envPath).stdout).toBe(key);
      const line = readFileSync(envPath, 'utf8')
        .split('\n')
        .find((entry) => entry.startsWith(`${KEY}=`))!;
      // Plainly single-quoted: the one form the launchd shell and systemd's
      // EnvironmentFile parser read the same way.
      expect(line).toBe(`${KEY}='${key}'`);
      expect(unquoteEnvValue(line.slice(`${KEY}=`.length))).toBe(key);
    });
  }, 30_000);

  test('every stale assignment of the key is removed, not just the first', () => {
    withEnvFile((_dir, envPath) => {
      // The shell takes the LAST assignment, so a duplicate below the one being
      // rewritten would hand the worker exactly the value this call replaced.
      writeFileSync(
        envPath,
        [`${KEY}=old-one`, 'PATH=/usr/bin', `${KEY}=old-two`, ''].join('\n'),
        { mode: 0o600 },
      );
      writeManagedWorkerEnvSecret({ key: KEY, value: 'fresh-key', envPath });

      const lines = readFileSync(envPath, 'utf8').split('\n').filter(Boolean);
      expect(lines.filter((line) => line.startsWith(`${KEY}=`))).toEqual([`${KEY}='fresh-key'`]);
      // The surviving assignment keeps the first one's position.
      expect(lines).toEqual([`${KEY}='fresh-key'`, 'PATH=/usr/bin']);
      expect(sourceValue(envPath).stdout).toBe('fresh-key');
    });
  }, 30_000);

  test('a control character is refused outright, because quoting cannot make it safe', () => {
    withEnvFile((_dir, envPath) => {
      const before = readFileSync(envPath, 'utf8');
      const forgedLine = ['key', 'OTHER=1'].join('\n');
      const carriageReturn = ['key', 'more'].join('\r');
      const tabbed = ['key', 'tab'].join('\t');
      const escapeSequence = `key${String.fromCharCode(27)}[2J`;
      for (const value of [forgedLine, carriageReturn, tabbed, escapeSequence]) {
        expect(() => writeManagedWorkerEnvSecret({ key: KEY, value, envPath }))
          .toThrow('must not contain control characters');
      }
      expect(readFileSync(envPath, 'utf8')).toBe(before);
    });
  });

  test('the file keeps owner-only permissions', () => {
    withEnvFile((_dir, envPath) => {
      writeManagedWorkerEnvSecret({ key: KEY, value: 'some-key', envPath });
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    });
  });
});

function withEnvFile(run: (dir: string, envPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-worker-env-secret-'));
  try {
    const envPath = join(dir, 'worker.env');
    writeFileSync(envPath, '# Olympus source worker environment.\nPATH=/usr/bin\n', { mode: 0o600 });
    run(dir, envPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
