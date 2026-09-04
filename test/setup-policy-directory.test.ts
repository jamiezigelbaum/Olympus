// olympus setup owns ~/.olympus, the private policy directory the install guide
// has an agent write a sensitivity map into.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { validateSensitivityMapFile } from '../src/core/sensitivity-map.ts';
import { runSetupDependencyCheck, runSetupWizard } from '../src/core/setup.ts';
import { OperationError } from '../src/core/operation-error.ts';

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
      });
      // The install guide has an agent write ~/.olympus/sensitivity-map.json
      // next to sovereignty.json, so the directory must exist afterwards, and
      // a directory that will hold a sensitivity map must not be group- or
      // world-readable.
      expect(statSync(policyDir).isDirectory()).toBe(true);
      expect(statSync(policyDir).mode & 0o777).toBe(0o700);

      // A missing map names the directory it belongs in rather than dead-ending.
      let error: unknown;
      try {
        validateSensitivityMapFile({ path: join(policyDir, 'sensitivity-map.json') });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).suggestion).toContain(policyDir);
      expect((error as OperationError).suggestion).toContain('olympus setup');
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

