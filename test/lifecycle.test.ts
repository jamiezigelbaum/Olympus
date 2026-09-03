import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  lifecycleRecoveryPlan,
  runWorkerLifecycle,
} from '../src/core/lifecycle.ts';
import { acquireLifecycleMutationLock } from '../src/core/lifecycle-lock.ts';
import {
  installWorkerService,
  workerServicePaths,
  type WorkerServiceExec,
} from '../src/core/worker-service.ts';

describe('versioned Olympus worker lifecycle', () => {
  test('Linux install is idempotent and reports the observed active state', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-linux-'));
    const manager = linuxManager('inactive');
    try {
      const first = runWorkerLifecycle('install', {
        platform: 'linux',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
        authToken: 'lifecycle-token',
        schedulerEnabled: true,
        exec: manager.exec,
      });
      const second = runWorkerLifecycle('install', {
        platform: 'linux',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
        authToken: 'another-token-that-must-not-replace-the-first',
        schedulerEnabled: true,
        exec: manager.exec,
      });
      chmodSync(workerServicePaths('linux', home).unitPath, 0o644);
      const permissionRepair = runWorkerLifecycle('install', {
        platform: 'linux',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
        schedulerEnabled: true,
        exec: manager.exec,
      });

      expect(first).toMatchObject({
        schema_version: 1,
        action: 'install',
        ok: true,
        changed: true,
        service: { state: 'active', unit_present: true, env_present: true },
      });
      expect(second).toMatchObject({
        schema_version: 1,
        action: 'install',
        ok: true,
        changed: false,
        service: { state: 'active' },
      });
      expect(permissionRepair).toMatchObject({
        action: 'install',
        changed: true,
        install: { wrote_unit: true, wrote_env: false },
      });
      expect(manager.calls.filter((call) => call === 'systemctl --user enable --now olympus-worker.service')).toHaveLength(2);
      expect(readFileSync(workerServicePaths('linux', home).envPath, 'utf8')).toContain('OLYMPUS_WORKER_AUTH_TOKEN=lifecycle-token');
      expect(existsSync(transactionPath(home))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('macOS start and restart are distinct and start bootstraps a stopped job', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-darwin-'));
    const manager = darwinManager('inactive');
    try {
      installWorkerService({
        platform: 'darwin',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
      });
      runWorkerLifecycle('start', { platform: 'darwin', homeDir: home, exec: manager.exec });
      runWorkerLifecycle('restart', { platform: 'darwin', homeDir: home, exec: manager.exec });
      runWorkerLifecycle('stop', { platform: 'darwin', homeDir: home, exec: manager.exec });
      const resumed = runWorkerLifecycle('start', { platform: 'darwin', homeDir: home, exec: manager.exec });

      expect(manager.calls.some((call) => /^launchctl kickstart gui\/.+\/com\.openclaw\.olympus\.worker$/.test(call))).toBe(true);
      expect(manager.calls.some((call) => /^launchctl kickstart -k gui\/.+\/com\.openclaw\.olympus\.worker$/.test(call))).toBe(true);
      expect(manager.calls.some((call) => /^launchctl bootstrap gui\/.+ \/.+com\.openclaw\.olympus\.worker\.plist$/.test(call))).toBe(true);
      expect(resumed).toMatchObject({ service: { state: 'active' } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('fresh macOS install accepts launchctl missing-service exit 113', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-darwin-fresh-'));
    const manager = darwinManager('missing');
    try {
      const receipt = runWorkerLifecycle('install', {
        platform: 'darwin',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
        authToken: 'lifecycle-token',
        exec: manager.exec,
      });

      expect(receipt).toMatchObject({
        schema_version: 1,
        action: 'install',
        ok: true,
        changed: true,
        service: { state: 'active', unit_present: true, env_present: true },
      });
      expect(manager.calls.some((call) => (
        call.startsWith('launchctl bootstrap gui/')
        && call.endsWith(workerServicePaths('darwin', home).unitPath)
      ))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('macOS waiting jobs with a nonzero last exit are failed, not healthy inactive', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-darwin-failed-'));
    try {
      installWorkerService({
        platform: 'darwin',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
      });
      const result = runWorkerLifecycle('status', {
        platform: 'darwin',
        homeDir: home,
        exec: darwinManager('failed').exec,
      });
      expect(result).toMatchObject({ ok: false, service: { state: 'failed', exit_code: 0 } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('status distinguishes missing, failed, and interrupted state without guessing', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-status-'));
    const missing = linuxManager('inactive');
    try {
      const missingStatus = runWorkerLifecycle('status', {
        platform: 'linux',
        homeDir: home,
        exec: missing.exec,
      });
      expect(missingStatus).toMatchObject({
        schema_version: 1,
        action: 'status',
        ok: true,
        service: { state: 'missing', unit_present: false },
        lifecycle_transaction: { state: 'none' },
      });

      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
      });
      const failed = linuxManager('failed');
      const failedStatus = runWorkerLifecycle('status', {
        platform: 'linux',
        homeDir: home,
        exec: failed.exec,
      });
      expect(failedStatus).toMatchObject({ ok: false, service: { state: 'failed', unit_present: true } });

      seedInterruptedTransaction(home, 'upgrade', 'activating');
      const interrupted = runWorkerLifecycle('status', {
        platform: 'linux',
        homeDir: home,
        exec: failed.exec,
      });
      expect(interrupted).toMatchObject({
        lifecycle_transaction: { state: 'interrupted', action: 'upgrade', phase: 'activating' },
        recovery: [{ kind: 'upgrade_interrupted', restart_required: false }],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rerunning an interrupted upgrade restores the old files before applying the new unit', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-interrupted-upgrade-'));
    const manager = linuxManager('active');
    const paths = workerServicePaths('linux', home);
    try {
      const artifact = createUpgradeArtifact(home, '0.4.0');
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'preserved-token',
      });
      const oldUnit = readFileSync(paths.unitPath, 'utf8');
      const oldEnv = readFileSync(paths.envPath, 'utf8');
      seedInterruptedTransaction(home, 'upgrade', 'activating', { oldUnit, oldEnv });
      writeFileSync(paths.unitPath, 'interrupted new unit\n', { mode: 0o600 });
      writeFileSync(paths.envPath, 'interrupted env\n', { mode: 0o600 });

      const result = runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: artifact.path,
        bunBin: process.execPath,
        exec: manager.exec,
        activationSettleMs: 0,
        readinessProbe: () => true,
      });
      const repeated = runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: artifact.path,
        bunBin: process.execPath,
        exec: manager.exec,
        activationSettleMs: 0,
        readinessProbe: () => true,
      });

      expect(result).toMatchObject({
        action: 'upgrade',
        changed: true,
        recovered_interrupted_transaction: true,
        service: { state: 'active' },
      });
      expect(readFileSync(paths.unitPath, 'utf8')).toContain(`WorkingDirectory=${artifact.managedRoot}`);
      expect(result).toMatchObject({ upgrade: { artifact_sha256: artifact.sha256, package_version: '0.4.0' } });
      expect(result).toMatchObject({ readiness: { status: 'ready', url: 'http://127.0.0.1:8010/v1/health' } });
      expect(repeated).toMatchObject({ changed: true, readiness: { status: 'ready' } });
      expect(readFileSync(paths.envPath, 'utf8')).toContain('OLYMPUS_WORKER_AUTH_TOKEN=preserved-token');
      expect(manager.calls.filter((call) => call === 'systemctl --user enable --now olympus-worker.service')).toHaveLength(3);
      expect(manager.calls.filter((call) => call === 'systemctl --user restart olympus-worker.service')).toHaveLength(3);
      expect(existsSync(transactionPath(home))).toBe(false);
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('a failed upgrade activation restores and reactivates the previous unit', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-upgrade-rollback-'));
    const paths = workerServicePaths('linux', home);
    const calls: string[] = [];
    let enableCalls = 0;
    let state: 'active' | 'inactive' = 'active';
    const exec: WorkerServiceExec = (command, args) => {
      const call = [command, ...args].join(' ');
      calls.push(call);
      if (call === 'systemctl --user is-active olympus-worker.service') {
        return state === 'active'
          ? { status: 0, stdout: 'active\n', stderr: '' }
          : { status: 3, stdout: 'inactive\n', stderr: '' };
      }
      if (call === 'systemctl --user daemon-reload') return { status: 0, stdout: 'reloaded\n', stderr: '' };
      if (call === 'systemctl --user enable --now olympus-worker.service') {
        enableCalls += 1;
        if (enableCalls === 1) return { status: 1, stdout: '', stderr: 'activation refused\n' };
        state = 'active';
        return { status: 0, stdout: 'old unit active\n', stderr: '' };
      }
      if (call === 'systemctl --user stop olympus-worker.service') {
        state = 'inactive';
        return { status: 0, stdout: 'inactive\n', stderr: '' };
      }
      if (call === 'systemctl --user restart olympus-worker.service') {
        state = 'active';
        return { status: 0, stdout: 'old unit restarted\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected ${call}` };
    };
    try {
      const artifact = createUpgradeArtifact(home, '0.4.1');
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'old-token',
      });
      const oldUnit = readFileSync(paths.unitPath, 'utf8');
      const oldEnv = readFileSync(paths.envPath, 'utf8');

      expect(() => runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: artifact.path,
        bunBin: process.execPath,
        exec,
        activationSettleMs: 0,
      })).toThrow('olympus worker install failed');

      expect(readFileSync(paths.unitPath, 'utf8')).toBe(oldUnit);
      expect(readFileSync(paths.envPath, 'utf8')).toBe(oldEnv);
      expect(enableCalls).toBe(2);
      expect(calls.filter((call) => call === 'systemctl --user daemon-reload')).toHaveLength(2);
      expect(existsSync(transactionPath(home))).toBe(false);
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('upgrade rolls back when the new worker briefly activates and then fails qualification', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-upgrade-qualification-'));
    const paths = workerServicePaths('linux', home);
    let statusCalls = 0;
    let enableCalls = 0;
    let state: 'active' | 'inactive' | 'failed' = 'active';
    const exec: WorkerServiceExec = (command, args) => {
      const call = [command, ...args].join(' ');
      if (call === 'systemctl --user is-active olympus-worker.service') {
        statusCalls += 1;
        if (statusCalls === 3) state = 'failed';
        return state === 'active'
          ? { status: 0, stdout: 'active\n', stderr: '' }
          : { status: 3, stdout: `${state}\n`, stderr: '' };
      }
      if (call === 'systemctl --user daemon-reload') return { status: 0, stdout: 'reloaded\n', stderr: '' };
      if (call === 'systemctl --user enable --now olympus-worker.service') {
        enableCalls += 1;
        state = 'active';
        return { status: 0, stdout: 'active\n', stderr: '' };
      }
      if (call === 'systemctl --user stop olympus-worker.service') {
        state = 'inactive';
        return { status: 0, stdout: 'inactive\n', stderr: '' };
      }
      if (call === 'systemctl --user restart olympus-worker.service') {
        state = 'active';
        return { status: 0, stdout: 'active\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected ${call}` };
    };
    try {
      const artifact = createUpgradeArtifact(home, '0.4.2');
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'old-token',
      });
      const oldUnit = readFileSync(paths.unitPath, 'utf8');

      expect(() => runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: artifact.path,
        bunBin: process.execPath,
        exec,
        activationSettleMs: 0,
      })).toThrow('did not remain active through qualification');

      expect(readFileSync(paths.unitPath, 'utf8')).toBe(oldUnit);
      expect(enableCalls).toBe(2);
      expect(existsSync(transactionPath(home))).toBe(false);
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('upgrade rolls back when the service manager is active but loopback readiness fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-upgrade-readiness-'));
    const paths = workerServicePaths('linux', home);
    const manager = linuxManager('active');
    try {
      const artifact = createUpgradeArtifact(home, '0.4.3');
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'old-token',
      });
      const oldUnit = readFileSync(paths.unitPath, 'utf8');
      let probedUrl = '';

      expect(() => runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: artifact.path,
        bunBin: process.execPath,
        exec: manager.exec,
        activationSettleMs: 0,
        readinessProbe: (url) => {
          probedUrl = url;
          return false;
        },
      })).toThrow('did not answer its loopback readiness probe');

      expect(probedUrl).toBe('http://127.0.0.1:8010/v1/health');
      expect(readFileSync(paths.unitPath, 'utf8')).toBe(oldUnit);
      expect(existsSync(transactionPath(home))).toBe(false);
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('upgrade reads a quoted readiness port the way both service managers source it', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-quoted-port-'));
    const paths = workerServicePaths('linux', home);
    const manager = linuxManager('active');
    try {
      const artifact = createUpgradeArtifact(home, '0.4.7');
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'old-token',
      });
      writeFileSync(
        paths.envPath,
        readFileSync(paths.envPath, 'utf8').replace(/^OLYMPUS_EMAIL_SOURCE_PORT=.*$/m, 'OLYMPUS_EMAIL_SOURCE_PORT="9090"'),
        { mode: 0o600 },
      );
      let probedUrl = '';

      const result = runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: artifact.path,
        bunBin: process.execPath,
        exec: manager.exec,
        activationSettleMs: 0,
        readinessProbe: (url) => {
          probedUrl = url;
          return true;
        },
      });

      expect(probedUrl).toBe('http://127.0.0.1:9090/v1/health');
      expect(result).toMatchObject({ ok: true, readiness: { status: 'ready', url: 'http://127.0.0.1:9090/v1/health' } });
      expect(readFileSync(paths.unitPath, 'utf8')).toContain(`WorkingDirectory=${artifact.managedRoot}`);
      expect(existsSync(transactionPath(home))).toBe(false);
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('an unreadable readiness port refuses the upgrade before any managed mutation', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-unreadable-port-'));
    const paths = workerServicePaths('linux', home);
    const manager = linuxManager('active');
    try {
      const artifact = createUpgradeArtifact(home, '0.4.8');
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'old-token',
      });
      writeFileSync(
        paths.envPath,
        readFileSync(paths.envPath, 'utf8').replace(/^OLYMPUS_EMAIL_SOURCE_PORT=.*$/m, 'OLYMPUS_EMAIL_SOURCE_PORT=not-a-port'),
        { mode: 0o600 },
      );
      const oldUnit = readFileSync(paths.unitPath, 'utf8');

      expect(() => runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: artifact.path,
        bunBin: process.execPath,
        exec: manager.exec,
        activationSettleMs: 0,
        readinessProbe: () => true,
      })).toThrow('invalid readiness port');

      expect(readFileSync(paths.unitPath, 'utf8')).toBe(oldUnit);
      expect(manager.calls).not.toContain('systemctl --user enable --now olympus-worker.service');
      expect(existsSync(transactionPath(home))).toBe(false);
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('rollback clears a latched systemd failure instead of wedging the lifecycle', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-latched-failure-'));
    const paths = workerServicePaths('linux', home);
    const calls: string[] = [];
    let statusCalls = 0;
    let state: 'active' | 'inactive' | 'failed' = 'active';
    const exec: WorkerServiceExec = (command, args) => {
      const call = [command, ...args].join(' ');
      calls.push(call);
      if (call === 'systemctl --user is-active olympus-worker.service') {
        statusCalls += 1;
        if (statusCalls === 3) state = 'failed';
        return state === 'active'
          ? { status: 0, stdout: 'active\n', stderr: '' }
          : { status: 3, stdout: `${state}\n`, stderr: '' };
      }
      if (call === 'systemctl --user daemon-reload') return { status: 0, stdout: 'reloaded\n', stderr: '' };
      if (call === 'systemctl --user enable --now olympus-worker.service') {
        state = 'active';
        return { status: 0, stdout: 'active\n', stderr: '' };
      }
      if (call === 'systemctl --user stop olympus-worker.service') {
        // Real systemd keeps a failed unit failed: stop returns success without
        // clearing the latched result, so only reset-failed can prove it is down.
        if (state !== 'failed') state = 'inactive';
        return { status: 0, stdout: '', stderr: '' };
      }
      if (call === 'systemctl --user reset-failed olympus-worker.service') {
        if (state === 'failed') state = 'inactive';
        return { status: 0, stdout: '', stderr: '' };
      }
      if (call === 'systemctl --user restart olympus-worker.service') {
        state = 'active';
        return { status: 0, stdout: 'active\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected ${call}` };
    };
    try {
      const artifact = createUpgradeArtifact(home, '0.4.9');
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'old-token',
      });
      const oldUnit = readFileSync(paths.unitPath, 'utf8');

      expect(() => runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: artifact.path,
        bunBin: process.execPath,
        exec,
        activationSettleMs: 0,
      })).toThrow('did not remain active through qualification');

      expect(calls).toContain('systemctl --user reset-failed olympus-worker.service');
      expect(readFileSync(paths.unitPath, 'utf8')).toBe(oldUnit);
      expect(existsSync(transactionPath(home))).toBe(false);
      expect(runWorkerLifecycle('status', {
        platform: 'linux',
        homeDir: home,
        exec,
      })).toMatchObject({ lifecycle_transaction: { state: 'none' } });
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('an install with a custom environment path records a transaction it can read back', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-custom-env-'));
    const outside = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-custom-env-outside-'));
    const envPath = join(outside, 'worker.env');
    const manager = linuxManager('inactive');
    try {
      const result = runWorkerLifecycle('install', {
        platform: 'linux',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
        authToken: 'custom-env-token',
        envPath,
        exec: manager.exec,
        activationSettleMs: 0,
      });

      expect(result).toMatchObject({
        ok: true,
        install: { env_path: envPath },
        service: { state: 'active', unit_present: true, env_present: true },
      });
      expect(readFileSync(envPath, 'utf8')).toContain('OLYMPUS_WORKER_AUTH_TOKEN=custom-env-token');
      expect(existsSync(transactionPath(home))).toBe(false);
      expect(runWorkerLifecycle('status', {
        platform: 'linux',
        homeDir: home,
        envPath,
        exec: manager.exec,
      })).toMatchObject({ ok: true, service: { env_present: true }, lifecycle_transaction: { state: 'none' } });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('failed Linux upgrade from inactive stops the attempted worker before restoring inactive state', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-upgrade-inactive-linux-'));
    const paths = workerServicePaths('linux', home);
    try {
      const artifact = createUpgradeArtifact(home, '0.4.5');
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'old-token',
      });
      const oldUnit = readFileSync(paths.unitPath, 'utf8');
      let state: 'active' | 'inactive' = 'inactive';
      let cachedUnit = oldUnit;
      let startedUnit = '';
      const calls: string[] = [];
      const exec: WorkerServiceExec = (command, args) => {
        const call = [command, ...args].join(' ');
        calls.push(call);
        if (call === 'systemctl --user is-active olympus-worker.service') {
          return state === 'active'
            ? { status: 0, stdout: 'active\n', stderr: '' }
            : { status: 3, stdout: 'inactive\n', stderr: '' };
        }
        if (call === 'systemctl --user daemon-reload') {
          cachedUnit = readFileSync(paths.unitPath, 'utf8');
          return { status: 0, stdout: 'reloaded\n', stderr: '' };
        }
        if (call === 'systemctl --user enable --now olympus-worker.service') {
          state = 'active';
          return { status: 0, stdout: 'active\n', stderr: '' };
        }
        if (call === 'systemctl --user stop olympus-worker.service') {
          state = 'inactive';
          return { status: 0, stdout: 'inactive\n', stderr: '' };
        }
        if (call === 'systemctl --user start olympus-worker.service') {
          startedUnit = cachedUnit;
          state = 'active';
          return { status: 0, stdout: 'active\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: `unexpected ${call}` };
      };

      expect(() => runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: artifact.path,
        bunBin: process.execPath,
        exec,
        activationSettleMs: 0,
        readinessProbe: () => false,
      })).toThrow('did not answer its loopback readiness probe');

      expect(readFileSync(paths.unitPath, 'utf8')).toBe(oldUnit);
      expect(cachedUnit).toBe(oldUnit);
      expect(calls.filter((call) => call === 'systemctl --user daemon-reload')).toHaveLength(2);
      expect(calls).toContain('systemctl --user stop olympus-worker.service');
      expect(runWorkerLifecycle('status', {
        platform: 'linux',
        homeDir: home,
        exec,
      })).toMatchObject({ service: { state: 'inactive' } });
      runWorkerLifecycle('start', { platform: 'linux', homeDir: home, exec });
      expect(startedUnit).toBe(oldUnit);
      expect(existsSync(transactionPath(home))).toBe(false);
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('failed macOS upgrade from inactive unloads the attempted worker before restoring bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-upgrade-inactive-darwin-'));
    const paths = workerServicePaths('darwin', home);
    const manager = darwinManager('inactive');
    try {
      const artifact = createUpgradeArtifact(home, '0.4.6');
      installWorkerService({
        platform: 'darwin',
        homeDir: home,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'old-token',
      });
      const oldUnit = readFileSync(paths.unitPath, 'utf8');

      expect(() => runWorkerLifecycle('upgrade', {
        platform: 'darwin',
        homeDir: home,
        artifactPath: artifact.path,
        bunBin: process.execPath,
        exec: manager.exec,
        activationSettleMs: 0,
        readinessProbe: () => false,
      })).toThrow('did not answer its loopback readiness probe');

      expect(readFileSync(paths.unitPath, 'utf8')).toBe(oldUnit);
      expect(manager.calls.filter((call) => call.startsWith('launchctl bootout '))).toHaveLength(2);
      expect(runWorkerLifecycle('status', {
        platform: 'darwin',
        homeDir: home,
        exec: manager.exec,
      })).toMatchObject({ service: { state: 'inactive' } });
      expect(runWorkerLifecycle('start', {
        platform: 'darwin',
        homeDir: home,
        exec: manager.exec,
      })).toMatchObject({ service: { state: 'active' } });
      expect(manager.calls.some((call) => /^launchctl bootstrap gui\/.+ \/.+com\.openclaw\.olympus\.worker\.plist$/.test(call))).toBe(true);
      expect(existsSync(transactionPath(home))).toBe(false);
    } finally {
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('upgrade commits only after the real loopback health endpoint answers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-upgrade-real-readiness-'));
    const server = await startReadinessServer();
    const manager = linuxManager('active');
    try {
      const artifact = createUpgradeArtifact(home, '0.4.4');
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'old-token',
        port: server.port,
      });

      const result = runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: artifact.path,
        bunBin: process.execPath,
        exec: manager.exec,
        activationSettleMs: 0,
        port: server.port,
      });

      expect(result).toMatchObject({
        ok: true,
        readiness: { status: 'ready', url: `http://127.0.0.1:${server.port}/v1/health` },
      });
      expect(manager.calls).toContain('systemctl --user restart olympus-worker.service');
    } finally {
      server.process.kill();
      await server.process.exited;
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('all mutating lifecycle commands share one exclusive owner lock', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-lock-'));
    const base = linuxManager('inactive');
    let nestedError: unknown;
    let attempted = false;
    const exec: WorkerServiceExec = (command, args) => {
      if (!attempted && [command, ...args].join(' ') === 'systemctl --user is-active olympus-worker.service') {
        attempted = true;
        try {
          runWorkerLifecycle('start', { platform: 'linux', homeDir: home, exec: base.exec });
        } catch (error) {
          nestedError = error;
        }
      }
      return base.exec(command, args);
    };
    try {
      const result = runWorkerLifecycle('install', {
        platform: 'linux',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
        authToken: 'lock-token',
        exec,
        activationSettleMs: 0,
      });
      expect(result).toMatchObject({ ok: true, service: { state: 'active' } });
      expect(nestedError).toBeInstanceOf(Error);
      expect((nestedError as Error).message).toContain('Another Olympus worker lifecycle mutation is active');
      expect(existsSync(transactionPath(home))).toBe(false);
      expect(existsSync(join(dirname(transactionPath(home)), 'mutation-v1.lock'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a lifecycle lock from a reused PID instance is recovered', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-reused-pid-'));
    const lockPath = join(dirname(transactionPath(home)), 'mutation-v1.lock');
    try {
      acquireLifecycleMutationLock(home, 'install');
      const stale = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        process_instance: { startTime: string };
      };
      stale.process_instance.startTime = `${BigInt(stale.process_instance.startTime) + 1n}`;
      writeFileSync(lockPath, `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });

      const replacement = acquireLifecycleMutationLock(home, 'upgrade');
      replacement.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('commit-ready recovery removes backups before the marker without rolling managed files back', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-commit-ready-'));
    const paths = workerServicePaths('linux', home);
    const manager = linuxManager('active');
    try {
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
        authToken: 'commit-ready-token',
      });
      seedInterruptedTransaction(home, 'install', 'commit_ready');
      const committedUnit = 'already committed unit\n';
      writeFileSync(paths.unitPath, committedUnit, { mode: 0o600 });

      const result = runWorkerLifecycle('install', {
        platform: 'linux',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
        exec: manager.exec,
        activationSettleMs: 0,
      });
      expect(result).toMatchObject({ recovered_interrupted_transaction: true });
      expect(readFileSync(paths.unitPath, 'utf8')).not.toContain('/opt/olympus-old');
      expect(existsSync(join(dirname(transactionPath(home)), 'worker-unit.backup'))).toBe(false);
      expect(existsSync(join(dirname(transactionPath(home)), 'worker-env.backup'))).toBe(false);
      expect(existsSync(transactionPath(home))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('upgrade rejects symlink-bearing archives before any managed mutation', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-unsafe-artifact-'));
    try {
      const artifact = createUnsafeUpgradeArtifact(home);
      expect(() => runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: artifact,
        bunBin: process.execPath,
        dryRun: true,
      })).toThrow('non-regular archive entry');
      expect(existsSync(join(home, '.local', 'share', 'olympus', 'versions'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('uninstall is idempotent and retains credentials, config, and indexed data', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-uninstall-'));
    const manager = linuxManager('active');
    const paths = workerServicePaths('linux', home);
    try {
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
        authToken: 'retained-token',
      });
      const first = runWorkerLifecycle('uninstall', { platform: 'linux', homeDir: home, exec: manager.exec });
      const second = runWorkerLifecycle('uninstall', { platform: 'linux', homeDir: home, exec: manager.exec });

      expect(first).toMatchObject({
        action: 'uninstall',
        changed: true,
        service: { state: 'missing', unit_present: false, env_present: true },
        retained: ['worker environment and credentials', 'source configuration', 'indexed data'],
      });
      expect(second).toMatchObject({ action: 'uninstall', changed: false });
      expect(existsSync(paths.unitPath)).toBe(false);
      expect(readFileSync(paths.envPath, 'utf8')).toContain('OLYMPUS_WORKER_AUTH_TOKEN=retained-token');
      expect(manager.calls.filter((call) => call === 'systemctl --user disable --now olympus-worker.service')).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('source recovery directs credential, pairing, capture, sync, and dependency repair without restart', () => {
    const plan = lifecycleRecoveryPlan([
      { kind: 'setup_interrupted' },
      { kind: 'oauth_pending', source_id: 'gmail.email' },
      { kind: 'pairing_pending', source_id: 'telegram.messages' },
      { kind: 'capture_interrupted', source_id: 'whatsapp.personal.messages' },
      { kind: 'partial_sync', source_id: 'dropbox.files' },
      { kind: 'missing_dependency', source_id: 'readwise.library', dependency_id: 'readwise_api_key' },
      { kind: 'upgrade_interrupted' },
      { kind: 'rollback_required' },
    ]);

    expect(plan.map((item) => item.kind)).toEqual([
      'setup_interrupted',
      'oauth_pending',
      'pairing_pending',
      'capture_interrupted',
      'partial_sync',
      'missing_dependency',
      'upgrade_interrupted',
      'rollback_required',
    ]);
    expect(plan.every((item) => item.restart_required === false)).toBe(true);
    expect(plan.find((item) => item.kind === 'partial_sync')?.next_action).toContain('checkpoint');
    expect(plan.find((item) => item.kind === 'oauth_pending')?.next_action).toContain('dashboard');
  });

  test('managed writes refuse symlinks and rendered fixtures contain no private-host assumptions', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-symlink-'));
    const target = join(home, 'outside-unit');
    const unitPath = workerServicePaths('linux', home).unitPath;
    try {
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(target, 'do not overwrite\n');
      symlinkSync(target, unitPath);
      const status = runWorkerLifecycle('status', {
        platform: 'linux',
        homeDir: home,
        exec: linuxManager('inactive').exec,
      });
      expect(status).toMatchObject({
        ok: false,
        service: { state: 'unknown', unit_present: false, detail: 'managed worker unit path is not a regular file' },
      });
      expect(() => installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
      })).toThrow('non-regular managed worker unit');
      expect(readFileSync(target, 'utf8')).toBe('do not overwrite\n');

      const fixtures = JSON.stringify([
        runWorkerLifecycle('install', {
          platform: 'darwin',
          homeDir: '/Users/friend',
          workingDirectory: '/Applications/Olympus',
          bunBin: process.execPath,
          dryRun: true,
        }),
        runWorkerLifecycle('install', {
          platform: 'linux',
          homeDir: '/home/friend',
          workingDirectory: '/opt/olympus',
          bunBin: process.execPath,
          dryRun: true,
        }),
      ]).toLowerCase();
      expect(fixtures).not.toContain('/users/zig');
      expect(fixtures).not.toContain('sparta');
      expect(fixtures).not.toContain('jamie');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('managed writes refuse symlinks in parent directory components', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-parent-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-parent-outside-'));
    const systemdRoot = join(home, '.config', 'systemd');
    try {
      mkdirSync(dirname(systemdRoot), { recursive: true });
      symlinkSync(outside, systemdRoot);
      const status = runWorkerLifecycle('status', {
        platform: 'linux',
        homeDir: home,
        exec: linuxManager('inactive').exec,
      });
      expect(status).toMatchObject({
        ok: false,
        service: { state: 'unknown', detail: 'managed worker path has an unsafe parent directory component' },
      });
      expect(() => runWorkerLifecycle('install', {
        platform: 'linux',
        homeDir: home,
        workingDirectory: process.cwd(),
        bunBin: process.execPath,
        exec: linuxManager('inactive').exec,
      })).toThrow('unsafe parent directory component');
      expect(existsSync(join(outside, 'user', 'olympus-worker.service'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('uninstall refuses a symlinked unit parent without deleting outside bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-uninstall-parent-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-uninstall-outside-'));
    const systemdRoot = join(home, '.config', 'systemd');
    const outsideUnit = join(outside, 'user', 'olympus-worker.service');
    try {
      mkdirSync(dirname(systemdRoot), { recursive: true });
      mkdirSync(dirname(outsideUnit), { recursive: true });
      writeFileSync(outsideUnit, 'outside unit must survive\n', { mode: 0o600 });
      symlinkSync(outside, systemdRoot);

      expect(() => runWorkerLifecycle('uninstall', {
        platform: 'linux',
        homeDir: home,
        exec: linuxManager('inactive').exec,
      })).toThrow('unsafe managed worker unit parent path');
      expect(readFileSync(outsideUnit, 'utf8')).toBe('outside unit must survive\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

function linuxManager(initial: 'active' | 'inactive' | 'failed') {
  let state = initial;
  const calls: string[] = [];
  const exec: WorkerServiceExec = (command, args) => {
    const call = [command, ...args].join(' ');
    calls.push(call);
    if (call === 'systemctl --user is-active olympus-worker.service') {
      return state === 'active'
        ? { status: 0, stdout: 'active\n', stderr: '' }
        : { status: 3, stdout: `${state}\n`, stderr: '' };
    }
    if (call === 'systemctl --user daemon-reload') return { status: 0, stdout: 'reloaded\n', stderr: '' };
    if (call === 'systemctl --user enable --now olympus-worker.service') {
      state = 'active';
      return { status: 0, stdout: 'active\n', stderr: '' };
    }
    if (call === 'systemctl --user disable --now olympus-worker.service') {
      state = 'inactive';
      return { status: 0, stdout: 'inactive\n', stderr: '' };
    }
    if (call === 'systemctl --user start olympus-worker.service' || call === 'systemctl --user restart olympus-worker.service') {
      state = 'active';
      return { status: 0, stdout: 'active\n', stderr: '' };
    }
    if (call === 'systemctl --user stop olympus-worker.service') {
      state = 'inactive';
      return { status: 0, stdout: 'inactive\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected ${call}` };
  };
  return { calls, exec };
}

function darwinManager(initial: 'active' | 'inactive' | 'missing' | 'failed') {
  let state: 'active' | 'inactive' | 'failed' = initial === 'missing' ? 'inactive' : initial;
  let loaded = initial !== 'missing';
  const calls: string[] = [];
  const exec: WorkerServiceExec = (command, args) => {
    const call = [command, ...args].join(' ');
    calls.push(call);
    if (args[0] === 'print') {
      if (!loaded) return { status: 113, stdout: '', stderr: 'Could not find service.\n' };
      return {
        status: 0,
        stdout: state === 'active'
          ? 'state = running\nlast exit code = 0\n'
          : `state = waiting\nlast exit code = ${state === 'failed' ? 1 : 0}\n`,
        stderr: '',
      };
    }
    if (args[0] === 'kickstart') {
      if (!loaded) return { status: 113, stdout: '', stderr: 'Could not find service.\n' };
      state = 'active';
      return { status: 0, stdout: 'started\n', stderr: '' };
    }
    if (args[0] === 'bootout') {
      loaded = false;
      state = 'inactive';
      return { status: 0, stdout: 'stopped\n', stderr: '' };
    }
    if (args[0] === 'bootstrap') {
      loaded = true;
      state = 'active';
      return { status: 0, stdout: 'active\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected ${call}` };
  };
  return { calls, exec };
}

function seedInterruptedTransaction(
  home: string,
  action: 'install' | 'upgrade',
  phase: 'snapshotting' | 'prepared' | 'activating' | 'qualifying' | 'rollback_required' | 'commit_ready',
  files?: { oldUnit: string; oldEnv: string },
): void {
  const paths = workerServicePaths('linux', home);
  const stateDir = dirname(transactionPath(home));
  mkdirSync(stateDir, { recursive: true });
  const oldUnit = files?.oldUnit ?? readFileSync(paths.unitPath, 'utf8');
  const oldEnv = files?.oldEnv ?? readFileSync(paths.envPath, 'utf8');
  writeFileSync(join(stateDir, 'worker-unit.backup'), oldUnit, { mode: 0o600 });
  writeFileSync(join(stateDir, 'worker-env.backup'), oldEnv, { mode: 0o600 });
  writeFileSync(transactionPath(home), `${JSON.stringify({
    schema_version: 1,
    action,
    phase,
    started_at: '2026-08-30T12:00:00.000Z',
    platform: 'linux',
    unit_path: paths.unitPath,
    env_path: paths.envPath,
    previous_unit_present: true,
    previous_env_present: true,
    previous_service_state: 'active',
    previous_unit_sha256: sha256(oldUnit),
    previous_env_sha256: sha256(oldEnv),
    desired_unit_sha256: sha256('interrupted new unit\n'),
    ...(action === 'upgrade' ? {
      artifact_sha256: 'a'.repeat(64),
      package_version: '0.3.9',
      desired_working_directory: join(home, '.local', 'share', 'olympus', 'versions', 'a'.repeat(64)),
    } : {}),
  }, null, 2)}\n`, { mode: 0o600 });
}

function transactionPath(home: string): string {
  return join(home, '.local', 'state', 'olympus', 'lifecycle', 'transaction-v1.json');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createUpgradeArtifact(home: string, version: string): {
  path: string;
  sha256: string;
  managedRoot: string;
} {
  const fixture = mkdtempSync(join(tmpdir(), 'olympus-upgrade-package-'));
  const packageRoot = join(fixture, 'package');
  const artifactPath = join(home, `olympus-${version}.tgz`);
  try {
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: 'olympus', version, type: 'module' })}\n`);
    writeFileSync(join(packageRoot, 'openclaw.plugin.json'), `${JSON.stringify({ id: 'olympus', version })}\n`);
    writeFileSync(join(packageRoot, 'dist', 'cli.js'), `console.log('olympus ${version}');\n`);
    const packed = Bun.spawnSync(['tar', '-czf', artifactPath, '-C', fixture, 'package']);
    if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
    const digest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
    return {
      path: artifactPath,
      sha256: digest,
      managedRoot: join(home, '.local', 'share', 'olympus', 'versions', digest),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function createUnsafeUpgradeArtifact(home: string): string {
  const fixture = mkdtempSync(join(tmpdir(), 'olympus-unsafe-upgrade-package-'));
  const packageRoot = join(fixture, 'package');
  const artifactPath = join(home, 'olympus-unsafe.tgz');
  try {
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: 'olympus', version: '0.4.0' })}\n`);
    writeFileSync(join(packageRoot, 'openclaw.plugin.json'), `${JSON.stringify({ id: 'olympus', version: '0.4.0' })}\n`);
    symlinkSync('/etc/passwd', join(packageRoot, 'dist', 'cli.js'));
    const packed = Bun.spawnSync(['tar', '-czf', artifactPath, '-C', fixture, 'package']);
    if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
    return artifactPath;
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

async function startReadinessServer(): Promise<{
  port: number;
  process: ReturnType<typeof Bun.spawn>;
}> {
  const script = [
    "const server = Bun.serve({",
    "  hostname: '127.0.0.1',",
    "  port: 0,",
    "  fetch(request) {",
    "    const url = new URL(request.url);",
    "    if (url.pathname !== '/v1/health') return new Response('not found', { status: 404 });",
    "    return Response.json({ reachable: true, status: 'ok' });",
    "  },",
    "});",
    "console.log(server.port);",
  ].join('\n');
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (!output.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  const port = Number(output.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    child.kill();
    throw new Error(`Readiness fixture did not publish a port: ${output}`);
  }
  return { port, process: child };
}

function makeTreeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSafe(path);
  if (!stats?.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) makeTreeWritable(join(path, entry));
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
