// olympus setup owns ~/.olympus, the private policy directory that holds the
// owner's privacy profile and tier rules.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runSetupDependencyCheck, runSetupWizard } from '../src/core/setup.ts';

describe('olympus setup private policy directory', () => {
  test('setup creates the private policy directory with owner-only permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-fresh-install-policy-dir-'));
    try {
      const policyDir = join(dir, '.olympus');
      await runSetupWizard({
        preset: 'no-sensitive',
        yes: true,
        sovereigntyPath: join(policyDir, 'sovereignty.json'),
        platform: 'linux',
        homeDir: dir,
        workingDirectory: process.cwd(),
        tokenGenerator: () => 'policy-dir-token',
        dependencyCheck: healthyDependencyCheck,
        exec: () => ({ status: 0, stdout: 'active\n', stderr: '' }),
      });
      // The privacy profile and tier rules live next to sovereignty.json, so
      // the directory must exist afterwards and must not be group- or
      // world-readable.
      expect(statSync(policyDir).isDirectory()).toBe(true);
      expect(statSync(policyDir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function healthyDependencyCheck() {
  return runSetupDependencyCheck({
    platform: 'linux',
    commandExists: (command) => command === 'bun' || command === 'node',
    commandVersion: () => '1.2.0',
    pythonModuleExists: () => false,
  });
}
