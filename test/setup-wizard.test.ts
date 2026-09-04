import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { acquireLifecycleMutationLock } from '../src/core/lifecycle-lock.ts';
import {
  runSetupDependencyCheck,
  runSetupWizard,
} from '../src/core/setup.ts';
import { workerAuthTokenFromConfig } from '../src/core/worker-auth.ts';
import {
  installWorkerService,
  workerServicePaths,
  type WorkerServiceExec,
} from '../src/core/worker-service.ts';

describe('olympus setup wizard', () => {
  test('runs non-interactive end-to-end against temp files and records secure-off as a user choice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-setup-test-'));
    const sovereigntyPath = join(dir, 'sovereignty.json');
    try {
      const result = await runSetupWizard({
        preset: 'no-sensitive',
        yes: true,
        sovereigntyPath,
        platform: 'linux',
        homeDir: dir,
        olympusBin: '/usr/local/bin/olympus',
        workingDirectory: dir,
        tokenGenerator: () => 'test-worker-token',
        dependencyCheck: () => runSetupDependencyCheck({
          platform: 'linux',
          commandExists: (command) => command === 'bun' || command === 'node',
          pythonModuleExists: () => false,
        }),
      });

      expect(result.ok).toBe(true);
      expect(result.venicePitch.shown).toBe(true);
      const pitch = result.venicePitch.text.join(' ');
      expect(pitch).toContain('ordinary API with a live-catalog Private or plain TEE model');
      expect(pitch).toContain('does not provide or qualify E2EE out of the box');
      expect(pitch).toContain('custom integrations are user-owned');
      expect(pitch).toContain('Secure corpora remain lexical-only in v0.4');
      expect(pitch).toContain('Turning the secure tier off is a deliberate choice');
      expect(pitch).not.toContain('Venice E2EE can be connected');
      expect(pitch).not.toContain('E2EE and Anonymized models are refused');
      expect(result.secureTierDecision).toBe('secure_off_user_choice');
      expect(result.cloudLane).toBe('subscription');
      expect(result.unmet_prerequisites.map((item) => item.id)).toContain('env:GEMINI_API_KEY');
      expect(result.worker.authTokenRef).toBe('worker.env:OLYMPUS_WORKER_AUTH_TOKEN');
      expect(result.dashboard.url).toBe('http://127.0.0.1:8010/dashboard');
      expect(existsSync(sovereigntyPath)).toBe(true);
      expect(JSON.parse(readFileSync(sovereigntyPath, 'utf8')).routes.secure_local.mode).toBe('disabled');
      expect(readFileSync(join(dir, '.config', 'olympus', 'worker.env'), 'utf8')).toContain('OLYMPUS_WORKER_AUTH_TOKEN=test-worker-token');
      expect(workerAuthTokenFromConfig(defaultConfig(), { env: { HOME: dir } })).toBe('test-worker-token');
      expect(JSON.stringify(result)).not.toContain('test-worker-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps subscription cloud lane first by default and supports explicit API-key cloud alternative', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-setup-cloud-lane-test-'));
    const subscriptionPath = join(dir, 'subscription.json');
    const apiKeyPath = join(dir, 'api-key.json');
    try {
      await runSetupWizard({
        preset: 'private-cloud-only',
        yes: true,
        sovereigntyPath: subscriptionPath,
        platform: 'linux',
        homeDir: join(dir, 'subscription-home'),
        env: { GEMINI_API_KEY: 'gemini-test-key' },
        secretStore: memorySecretStore({ 'venice.api_key': 'venice-test-key' }),
        tokenGenerator: () => 'subscription-token',
        dependencyCheck: healthyDependencyCheck,
      });
      await runSetupWizard({
        preset: 'private-cloud-only',
        yes: true,
        cloudLane: 'api-key',
        sovereigntyPath: apiKeyPath,
        platform: 'linux',
        homeDir: join(dir, 'api-key-home'),
        env: { OPENAI_API_KEY: 'openai-test-key', GEMINI_API_KEY: 'gemini-test-key' },
        secretStore: memorySecretStore({ 'venice.api_key': 'venice-test-key' }),
        tokenGenerator: () => 'api-key-token',
        dependencyCheck: healthyDependencyCheck,
      });

      const subscription = JSON.parse(readFileSync(subscriptionPath, 'utf8'));
      const apiKey = JSON.parse(readFileSync(apiKeyPath, 'utf8'));
      expect(subscription.routes.secure_local.pool).toEqual({
        members: ['venice-private'],
      });
      expect(subscription.modelProfiles['local-source-answer']).toBeUndefined();
      expect(subscription.modelProfiles['venice-private'].secretRef).toBe('store:venice.api_key');
      expect(subscription.modelProfiles['cloud-openclaw-infer'].provider).toBe('openclaw-infer');
      expect(apiKey.modelProfiles['cloud-openclaw-infer']).toMatchObject({
        provider: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        secretRef: 'env:OPENAI_API_KEY',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails before writing setup files when required dependencies are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-setup-deps-test-'));
    const sovereigntyPath = join(dir, 'sovereignty.json');
    try {
      await expect(runSetupWizard({
        preset: 'private-cloud-only',
        yes: true,
        sovereigntyPath,
        platform: 'linux',
        homeDir: dir,
        tokenGenerator: () => 'unused-token',
        dependencyCheck: () => runSetupDependencyCheck({
          platform: 'linux',
          commandExists: (command) => command === 'node',
          pythonModuleExists: () => false,
        }),
      })).rejects.toMatchObject({
        code: 'config_error',
        message: expect.stringContaining('Bun'),
        suggestion: expect.stringContaining('Install Bun'),
      });

      expect(existsSync(sovereigntyPath)).toBe(false);
      expect(existsSync(join(dir, '.config', 'olympus', 'worker.env'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flags Bun below the setup minimum version as a required dependency failure', () => {
    const result = runSetupDependencyCheck({
      platform: 'linux',
      commandExists: (command) => command === 'bun' || command === 'node',
      commandVersion: (command) => command === 'bun' ? '1.1.42' : '20.0.0',
      pythonModuleExists: () => false,
    });

    const bun = result.checks.find((check) => check.id === 'bun');
    expect(result.ok).toBe(false);
    expect(bun?.ok).toBe(false);
    expect(bun?.detail).toContain('Bun 1.1.42');
    expect(bun?.repairHint).toContain('Bun 1.2+');
  });

  test('preflights no-sensitive missing and present GEMINI_API_KEY prerequisites', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-setup-preflight-cloud-test-'));
    try {
      const missing = await runSetupWizard({
        preset: 'no-sensitive',
        yes: true,
        sovereigntyPath: join(dir, 'missing.json'),
        platform: 'linux',
        homeDir: join(dir, 'missing-home'),
        env: {},
        tokenGenerator: () => 'missing-token',
        dependencyCheck: healthyDependencyCheck,
      });
      expect(missing.unmet_prerequisites).toMatchObject([{
        id: 'env:GEMINI_API_KEY',
        kind: 'env_secret',
        // An export in the operator's shell never reaches the launchd worker,
        // so the remedy names the command that writes the key into worker.env.
        remedy: 'printf \'%s\' "$KEY" | olympus connect gemini --api-key-stdin',
      }]);

      const present = await runSetupWizard({
        preset: 'no-sensitive',
        yes: true,
        sovereigntyPath: join(dir, 'present.json'),
        platform: 'linux',
        homeDir: join(dir, 'present-home'),
        env: { GEMINI_API_KEY: 'gemini-test-key' },
        tokenGenerator: () => 'present-token',
        dependencyCheck: healthyDependencyCheck,
      });
      expect(present.unmet_prerequisites).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preflights private-cloud-only store secret and Gemini without local server expectations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-setup-preflight-private-test-'));
    try {
      const missing = await runSetupWizard({
        preset: 'private-cloud-only',
        yes: true,
        sovereigntyPath: join(dir, 'missing.json'),
        platform: 'linux',
        homeDir: join(dir, 'missing-home'),
        env: {},
        secretStore: memorySecretStore({}),
        tokenGenerator: () => 'missing-token',
        dependencyCheck: healthyDependencyCheck,
      });
      expect(missing.unmet_prerequisites.map((item) => item.id)).toEqual([
        'store:venice.api_key',
        'env:GEMINI_API_KEY',
      ]);
      expect(missing.unmet_prerequisites.find((item) => item.id === 'store:venice.api_key')?.remedy)
        .toContain('olympus connect venice --api-key-stdin');
      expect(missing.unmet_prerequisites.map((item) => item.kind)).not.toContain('local_model_server');

      const withSecrets = await runSetupWizard({
        preset: 'private-cloud-only',
        yes: true,
        sovereigntyPath: join(dir, 'present.json'),
        platform: 'linux',
        homeDir: join(dir, 'present-home'),
        env: { GEMINI_API_KEY: 'gemini-test-key' },
        secretStore: memorySecretStore({ 'venice.api_key': 'venice-test-key' }),
        tokenGenerator: () => 'present-token',
        dependencyCheck: healthyDependencyCheck,
      });
      expect(withSecrets.unmet_prerequisites).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preflights local-first Venice, Gemini, and local model server expectations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-setup-preflight-local-test-'));
    try {
      const result = await runSetupWizard({
        preset: 'local-first',
        yes: true,
        sovereigntyPath: join(dir, 'sovereignty.json'),
        platform: 'linux',
        homeDir: dir,
        env: {},
        tokenGenerator: () => 'local-token',
        dependencyCheck: healthyDependencyCheck,
      });
      expect(result.unmet_prerequisites.map((item) => item.id)).toEqual([
        'local_model_server:local-source-answer:http://127.0.0.1:28090/v1',
        'store:venice.api_key',
        'local_model_server:local-source-embedding:http://127.0.0.1:28090/v1',
        'env:GEMINI_API_KEY',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preflights local-only Gemini and local model servers without Venice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-setup-preflight-local-only-test-'));
    try {
      const result = await runSetupWizard({
        preset: 'local-only',
        yes: true,
        sovereigntyPath: join(dir, 'sovereignty.json'),
        platform: 'linux',
        homeDir: dir,
        env: {},
        tokenGenerator: () => 'local-only-token',
        dependencyCheck: healthyDependencyCheck,
      });
      expect(result.unmet_prerequisites.map((item) => item.id)).toEqual([
        'local_model_server:local-source-answer:http://127.0.0.1:28090/v1',
        'local_model_server:local-source-embedding:http://127.0.0.1:28090/v1',
        'env:GEMINI_API_KEY',
      ]);
      expect(result.unmet_prerequisites.map((item) => item.id)).not.toContain('store:venice.api_key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('runs the connect loop through the injected connect command seam', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-setup-connect-loop-test-'));
    const connected: string[] = [];
    try {
      const result = await runSetupWizard({
        preset: 'private-cloud-only',
        yes: true,
        sovereigntyPath: join(dir, 'sovereignty.json'),
        platform: 'linux',
        homeDir: dir,
        tokenGenerator: () => 'connect-loop-token',
        dependencyCheck: healthyDependencyCheck,
        connectSources: ['venice', 'readwise'],
        connectSource: async (source) => {
          connected.push(source);
          return { ok: true, source };
        },
      });

      expect(connected).toEqual(['venice', 'readwise']);
      expect(result.connections).toEqual([
        { source: 'venice', status: 'connected', result: { ok: true, source: 'venice' } },
        { source: 'readwise', status: 'connected', result: { ok: true, source: 'readwise' } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setup mutates the managed worker files under the lifecycle lock and transaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-setup-lifecycle-custody-'));
    const lockedHome = join(dir, 'locked-home');
    const interruptedHome = join(dir, 'interrupted-home');
    const paths = workerServicePaths('linux', interruptedHome);
    try {
      mkdirSync(lockedHome, { recursive: true, mode: 0o700 });
      const lock = acquireLifecycleMutationLock(lockedHome, 'upgrade');
      try {
        await expect(runSetupWizard({
          preset: 'private-cloud-only',
          yes: true,
          sovereigntyPath: join(dir, 'locked.json'),
          platform: 'linux',
          homeDir: lockedHome,
          tokenGenerator: () => 'locked-token',
          dependencyCheck: healthyDependencyCheck,
        })).rejects.toMatchObject({
          message: expect.stringContaining('Another Olympus worker lifecycle mutation is active'),
        });
      } finally {
        lock.release();
      }

      installWorkerService({
        platform: 'linux',
        homeDir: interruptedHome,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'interrupted-token',
      });
      seedInterruptedInstall(interruptedHome);
      const manager = linuxManager();

      const recovered = await runSetupWizard({
        preset: 'private-cloud-only',
        yes: true,
        sovereigntyPath: join(dir, 'interrupted.json'),
        platform: 'linux',
        homeDir: interruptedHome,
        workingDirectory: dir,
        tokenGenerator: () => 'recovered-token',
        dependencyCheck: healthyDependencyCheck,
        exec: manager.exec,
      });

      expect(recovered.ok).toBe(true);
      expect(existsSync(transactionPath(interruptedHome))).toBe(false);
      expect(manager.calls).toContain('systemctl --user stop olympus-worker.service');
      expect(readFileSync(paths.envPath, 'utf8')).toContain('OLYMPUS_WORKER_AUTH_TOKEN=interrupted-token');
      expect(readFileSync(paths.unitPath, 'utf8')).toContain(`WorkingDirectory=${dir}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('CLI supports --preset/--yes non-interactive CI mode without printing the generated token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-setup-cli-test-'));
    const sovereigntyPath = join(dir, 'sovereignty.json');
    try {
      const proc = Bun.spawn([
        process.execPath,
        'src/cli.ts',
        'setup',
        '--preset',
        'private-cloud-only',
        '--yes',
        '--path',
        sovereigntyPath,
        '--platform',
        'linux',
        '--home',
        dir,
        '--olympus-bin',
        '/usr/local/bin/olympus',
      ], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(stderr || stdout);

      const output = JSON.parse(stdout);
      expect(output).toMatchObject({
        ok: true,
        preset: 'private-cloud-only',
        secureTierDecision: 'private_cloud_only',
        cloudLane: 'subscription',
      });
      expect(stderr).toContain('Unmet preset prerequisites:');
      expect(stderr).toContain('olympus connect gemini --api-key-stdin');
      expect(stderr).not.toContain('export GEMINI_API_KEY=');
      expect(stderr).toContain('olympus connect venice --api-key-stdin');
      expect(stdout).not.toContain('OLYMPUS_WORKER_AUTH_TOKEN=');
      expect(readFileSync(join(dir, '.config', 'olympus', 'worker.env'), 'utf8')).toContain('OLYMPUS_WORKER_AUTH_TOKEN=');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

function healthyDependencyCheck() {
  return runSetupDependencyCheck({
    platform: 'linux',
    commandExists: (command) => command === 'bun' || command === 'node',
    commandVersion: (command) => command === 'bun' ? '1.2.0' : undefined,
    pythonModuleExists: () => false,
  });
}

function transactionPath(home: string): string {
  return join(home, '.local', 'state', 'olympus', 'lifecycle', 'transaction-v1.json');
}

function seedInterruptedInstall(home: string): void {
  const paths = workerServicePaths('linux', home);
  const stateDir = dirname(transactionPath(home));
  const unit = readFileSync(paths.unitPath, 'utf8');
  const env = readFileSync(paths.envPath, 'utf8');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'worker-unit.backup'), unit, { mode: 0o600 });
  writeFileSync(join(stateDir, 'worker-env.backup'), env, { mode: 0o600 });
  writeFileSync(transactionPath(home), `${JSON.stringify({
    schema_version: 1,
    action: 'install',
    phase: 'activating',
    started_at: '2026-08-30T12:00:00.000Z',
    platform: 'linux',
    unit_path: paths.unitPath,
    env_path: paths.envPath,
    previous_unit_present: true,
    previous_env_present: true,
    previous_service_state: 'active',
    previous_unit_sha256: createHash('sha256').update(unit).digest('hex'),
    previous_env_sha256: createHash('sha256').update(env).digest('hex'),
    desired_unit_sha256: createHash('sha256').update('interrupted new unit\n').digest('hex'),
  }, null, 2)}\n`, { mode: 0o600 });
}

function linuxManager() {
  let state: 'active' | 'inactive' = 'active';
  const calls: string[] = [];
  const exec: WorkerServiceExec = (command, args) => {
    const call = [command, ...args].join(' ');
    calls.push(call);
    if (call === 'systemctl --user is-active olympus-worker.service') {
      return state === 'active'
        ? { status: 0, stdout: 'active\n', stderr: '' }
        : { status: 3, stdout: 'inactive\n', stderr: '' };
    }
    if (call === 'systemctl --user stop olympus-worker.service') {
      state = 'inactive';
      return { status: 0, stdout: 'inactive\n', stderr: '' };
    }
    if (call === 'systemctl --user daemon-reload') return { status: 0, stdout: 'reloaded\n', stderr: '' };
    state = 'active';
    return { status: 0, stdout: 'active\n', stderr: '' };
  };
  return { calls, exec };
}

function memorySecretStore(secrets: Record<string, string | undefined>) {
  return {
    getSync: (key: string) => secrets[key],
    get: async (key: string) => secrets[key],
  };
}
