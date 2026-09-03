// The commit guard is the whole compare-and-commit mechanism: ownership
// verification and the write callback are one operation only because the guard
// is held. A process whose own `open` failed never created that file, so its
// cleanup path must not remove it — deleting a live holder's guard lets a third
// party into the guarded region beside the owner.
//
// Resource exhaustion is the only class of open failure that arrives BEFORE the
// kernel's O_EXCL existence check, so it is the only way a caller can see
// something other than EEXIST while another party's guard is on disk. The child
// runs under a lowered descriptor limit to produce exactly that.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('file lease commit guard', () => {
  test('a descriptor-exhausted open leaves another holder’s commit guard in place', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-commit-guard-open-'));
    roots.push(root);
    const targetPath = join(root, 'credential-state.json');
    const probePath = join(root, 'probe');
    writeFileSync(probePath, 'probe\n', { mode: 0o600 });

    const result = Bun.spawnSync([
      '/bin/sh',
      '-c',
      'ulimit -n 200; exec "$0" --eval "$1"',
      process.execPath,
      contenderScript(targetPath, probePath),
    ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });

    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode, stderr).toBe(0);
    const outcome = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      code: string;
      guardSurvived: boolean;
    };
    expect(outcome.code).toMatch(/^E[MN]FILE$/);
    expect(outcome.guardSurvived).toBe(true);
    expect(existsSync(`${targetPath}.lock.commit`)).toBe(false);
  }, 30_000);
});

function contenderScript(targetPath: string, probePath: string): string {
  return `
import { closeSync, existsSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { withFileLease } from './src/core/file-lease.ts';

const targetPath = ${JSON.stringify(targetPath)};
const guardPath = targetPath + '.lock.commit';

const outcome = await withFileLease(targetPath, async (lease) => {
  // Another party is inside its guarded region, and its record names a live
  // process so no abandoned-guard takeover is eligible.
  writeFileSync(guardPath, JSON.stringify({
    version: 1,
    token: 'foreign-commit-guard-token',
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  }), { mode: 0o600 });

  const descriptors = [];
  let code = 'no_error';
  try {
    for (;;) {
      try {
        descriptors.push(openSync(${JSON.stringify(probePath)}, 'r'));
      } catch {
        break;
      }
    }
    try {
      await lease.commit(async () => 'committed');
    } catch (error) {
      code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown_error';
    }
  } finally {
    for (const descriptor of descriptors) {
      try {
        closeSync(descriptor);
      } catch {
        // The limit is being unwound; a failed close cannot change the verdict.
      }
    }
  }

  const guardSurvived = existsSync(guardPath);
  rmSync(guardPath, { force: true });
  return { code, guardSurvived };
}, { acquireTimeoutMs: 1_000, pollIntervalMs: 5, staleAfterMs: 50, heartbeatIntervalMs: 60_000 });

process.stdout.write(JSON.stringify(outcome));
`;
}
