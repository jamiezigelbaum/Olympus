// A fresh install enables the worker scheduler before any source is connected.
// Rehearsed on a clean macOS laptop, 2026-09-04: the worker refused to boot
// because that combination was rejected, and the failure said only "inactive".
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/core/config.ts';
import { runWorkerLifecycle } from '../src/core/lifecycle.ts';
import { runSetupDependencyCheck, runSetupWizard } from '../src/core/setup.ts';
import { OperationError } from '../src/core/operation-error.ts';
import {
  workerServiceFailureLogLine,
  workerServicePaths,
  type WorkerServiceExec,
} from '../src/core/worker-service.ts';
import { createSourceSchedulerFromConfig } from '../src/workers/source-scheduler.ts';

describe('fresh install worker scheduler', () => {
  test('setup installs a worker whose environment loads, with an enabled scheduler and no sources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-fresh-install-'));
    try {
      const result = await runSetupWizard({
        preset: 'no-sensitive',
        yes: true,
        sovereigntyPath: join(dir, '.olympus', 'sovereignty.json'),
        platform: 'linux',
        homeDir: dir,
        workingDirectory: process.cwd(),
        tokenGenerator: () => 'fresh-install-token',
        dependencyCheck: healthyDependencyCheck,
      });
      expect(result.ok).toBe(true);

      const workerEnv = parseEnvFile(readFileSync(result.worker.install.env_path, 'utf8'));
      // The install step runs BEFORE any source is connected, so the scheduler
      // is enabled with no allowlist. That combination used to be a refusal
      // from config validation, which made worker install/start/foreground
      // fail on every fresh install.
      expect(workerEnv.OLYMPUS_WORKER_SCHEDULER_ENABLED).toBe('true');
      expect(workerEnv.OLYMPUS_WORKER_SCHEDULER_SOURCE_IDS).toBeUndefined();

      const config = loadConfig({
        OLYMPUS_CONFIG: join(dir, 'config-that-does-not-exist.json'),
        ...workerEnv,
      });
      expect(config.worker.scheduler.enabled).toBe(true);
      expect(config.worker.scheduler.sourceIds).toEqual([]);

      // With nothing connected the worker constructs no lanes; the scheduler
      // must still start, and must stay ready to adopt the first source.
      const scheduler = createSourceSchedulerFromConfig({ config, sources: [] });
      scheduler.start();
      try {
        const status = scheduler.status();
        expect(status.enabled).toBe(true);
        expect(status.running).toBe(true);
        expect(status.sources).toEqual([]);
        expect(status.missing_selected_source_ids).toEqual([]);
      } finally {
        scheduler.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);


  test('a worker that exits on boot reports its own last log line, not just "inactive"', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-fresh-install-boot-failure-'));
    try {
      const paths = workerServicePaths('linux', home);
      mkdirSync(join(home, '.local', 'state', 'olympus', 'worker'), { recursive: true });
      writeFileSync(
        paths.errorLogPath,
        'starting\nerror: worker.scheduler.sourceIds must contain at least one source\n',
      );
      expect(workerServiceFailureLogLine({ platform: 'linux', homeDir: home }))
        .toBe('error: worker.scheduler.sourceIds must contain at least one source');

      let error: unknown;
      try {
        runWorkerLifecycle('install', {
          platform: 'linux',
          homeDir: home,
          workingDirectory: process.cwd(),
          bunBin: process.execPath,
          authToken: 'boot-failure-token',
          schedulerEnabled: true,
          exec: alwaysInactiveLinuxManager(),
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(OperationError);
      const message = (error as OperationError).message;
      expect(message).toContain('worker status is inactive');
      expect(message).toContain("worker's last log line");
      expect(message).toContain('must contain at least one source');
      expect((error as OperationError).suggestion).toContain(paths.errorLogPath);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);


  test('a token-shaped fragment in the worker log is redacted before it is quoted back', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-fresh-install-log-redaction-'));
    try {
      const paths = workerServicePaths('linux', home);
      mkdirSync(join(home, '.local', 'state', 'olympus', 'worker'), { recursive: true });
      writeFileSync(paths.errorLogPath, 'refused: Authorization: Bearer sk-not-a-real-token-value\n');
      const line = workerServiceFailureLogLine({ platform: 'linux', homeDir: home });
      expect(line).toContain('[redacted]');
      expect(line).not.toContain('sk-not-a-real-token-value');
    } finally {
      rmSync(home, { recursive: true, force: true });
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

/** A service manager that accepts the enable but never reports active. */
function alwaysInactiveLinuxManager(): WorkerServiceExec {
  return (command, args) => {
    const call = [command, ...args].join(' ');
    if (call === 'systemctl --user is-active olympus-worker.service') {
      return { status: 3, stdout: 'inactive\n', stderr: '' };
    }
    if (
      call === 'systemctl --user daemon-reload'
      || call === 'systemctl --user enable --now olympus-worker.service'
      || call === 'systemctl --user stop olympus-worker.service'
      || call === 'systemctl --user disable --now olympus-worker.service'
      || call === 'systemctl --user reset-failed olympus-worker.service'
    ) {
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected ${call}` };
  };
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]!] = match[2] ?? '';
  }
  return env;
}
