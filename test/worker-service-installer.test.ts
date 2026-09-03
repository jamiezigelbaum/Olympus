import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import {
  installWorkerService,
  runWorkerServiceAction,
  workerServicePaths,
} from '../src/core/worker-service.ts';

describe('generic Olympus worker installer', () => {
  test('generates a macOS launchd unit with login start, restart, env, and logs', () => {
    const result = installWorkerService({
      platform: 'darwin',
      homeDir: '/Users/friend',
      workingDirectory: '/opt/openclaw/plugins/olympus',
      dryRun: true,
      authToken: 'worker-token-fixture',
      schedulerEnabled: true,
    });

    expect(result.unit_path).toBe('/Users/friend/Library/LaunchAgents/com.openclaw.olympus.worker.plist');
    expect(result.env_path).toBe('/Users/friend/.config/olympus/worker.env');
    expect(result.log_path).toBe('/Users/friend/Library/Logs/Olympus/worker.log');
    expect(result.unit).toContain('<key>Label</key>');
    expect(result.unit).toContain('<string>com.openclaw.olympus.worker</string>');
    expect(result.unit).toContain('<key>RunAtLoad</key>');
    expect(result.unit).toContain('<key>KeepAlive</key>');
    expect(result.unit).toContain('<key>ThrottleInterval</key>');
    expect(result.unit).toContain('<integer>60</integer>');
    expect(result.unit).toContain('<string>/bin/sh</string>');
    expect(result.unit).toContain('set -a; [ -f &apos;/Users/friend/.config/olympus/worker.env&apos; ]');
    expect(result.unit).toContain(`exec &apos;${process.execPath}&apos;`);
    expect(result.unit).toContain('/opt/openclaw/plugins/olympus/dist/cli.js&apos; &apos;__worker-service-run&apos;');
    expect(result.unit).not.toContain('/bin/zsh');
    expect(result.unit).not.toContain('bin/olympus');
    expect(result.unit).toContain('/Users/friend/Library/Logs/Olympus/worker.log');
    expect(result.unit).not.toContain('worker-token-fixture');
    expect(result.commands.status).toEqual(['launchctl', 'print', expect.stringContaining('com.openclaw.olympus.worker')]);
    expect(result.wrote_unit).toBe(false);
  });

  test('generates a Linux user-systemd unit with env file and stable log paths', () => {
    const result = installWorkerService({
      platform: 'linux',
      homeDir: '/home/friend',
      workingDirectory: '/home/friend/.local/share/openclaw/plugins/olympus',
      dryRun: true,
    });

    expect(result.unit_path).toBe('/home/friend/.config/systemd/user/olympus-worker.service');
    expect(result.env_path).toBe('/home/friend/.config/olympus/worker.env');
    expect(result.log_path).toBe('/home/friend/.local/state/olympus/worker/worker.log');
    expect(result.error_log_path).toBe('/home/friend/.local/state/olympus/worker/worker.err');
    expect(result.unit).toContain('[Unit]');
    expect(result.unit).toContain('Description=Olympus source worker');
    expect(result.unit).toContain('EnvironmentFile=-/home/friend/.config/olympus/worker.env');
    expect(result.unit).toContain(`ExecStart=${process.execPath} /home/friend/.local/share/openclaw/plugins/olympus/dist/cli.js __worker-service-run`);
    expect(result.unit).not.toContain('ExecStart=olympus worker run');
    expect(result.unit).not.toContain('bin/olympus worker run');
    expect(result.unit).toContain('Restart=on-failure');
    expect(result.unit).toContain('WantedBy=default.target');
    expect(result.unit).toContain('StandardOutput=append:/home/friend/.local/state/olympus/worker/worker.log');
    expect(result.commands.install).toEqual(['systemctl', '--user', 'enable', '--now', 'olympus-worker.service']);
    expect(result.commands.start).toEqual(['systemctl', '--user', 'start', 'olympus-worker.service']);
    expect(result.commands.stop).toEqual(['systemctl', '--user', 'stop', 'olympus-worker.service']);
  });

  test('default Linux user-systemd unit does not depend on interactive PATH lookup', () => {
    const result = installWorkerService({
      platform: 'linux',
      homeDir: '/home/friend',
      workingDirectory: '/home/friend/.local/share/openclaw/plugins/olympus',
      dryRun: true,
    });

    expect(result.unit).toContain(`ExecStart=${process.execPath} /home/friend/.local/share/openclaw/plugins/olympus/dist/cli.js __worker-service-run`);
    expect(result.unit).not.toContain('ExecStart=olympus worker run');
    expect(result.unit).not.toContain(`${process.execPath} /home/friend/.local/share/openclaw/plugins/olympus/bin/olympus worker run`);
    expect(result.unit).not.toContain('/usr/bin/env bun');
  });

  test('ignores the legacy --olympus-bin override for the generated service command', () => {
    const result = installWorkerService({
      platform: 'linux',
      homeDir: '/home/friend',
      olympusBin: '/usr/local/bin/olympus',
      workingDirectory: '/home/friend/.local/share/openclaw/plugins/olympus',
      dryRun: true,
    });

    expect(result.unit).toContain(`ExecStart=${process.execPath} /home/friend/.local/share/openclaw/plugins/olympus/dist/cli.js __worker-service-run`);
    expect(result.unit).not.toContain(`${process.execPath} /usr/local/bin/olympus`);
    expect(result.unit).not.toContain('ExecStart=/usr/local/bin/olympus worker run');
  });

  test('never points bun at the POSIX bin/olympus wrapper', () => {
    const result = installWorkerService({
      platform: 'linux',
      homeDir: '/home/friend',
      olympusBin: '/opt/openclaw/plugins/olympus/bin/olympus',
      bunBin: process.execPath,
      workingDirectory: '/opt/openclaw/plugins/olympus',
      dryRun: true,
    });

    expect(result.unit).toContain(`ExecStart=${process.execPath} /opt/openclaw/plugins/olympus/dist/cli.js __worker-service-run`);
    expect(result.unit).not.toContain(`${process.execPath} /opt/openclaw/plugins/olympus/bin/olympus`);
    expect(result.unit).not.toContain('bin/olympus worker run');
  });

  test('keeps generated paths under user-owned roots', () => {
    expect(workerServicePaths('darwin', '/Users/friend').unitPath.startsWith('/Users/friend/')).toBe(true);
    expect(workerServicePaths('linux', '/home/friend').unitPath.startsWith('/home/friend/')).toBe(true);
  });

  test('runs platform install commands through an injectable service-manager exec', () => {
    const calls: string[] = [];
    const linux = runWorkerServiceAction('install', {
      platform: 'linux',
      homeDir: '/home/friend',
      exec: (command, args) => {
        calls.push([command, ...args].join(' '));
        return { status: 0, stdout: 'enabled\n', stderr: '' };
      },
    });
    const darwin = runWorkerServiceAction('install', {
      platform: 'darwin',
      homeDir: '/Users/friend',
      exec: (command, args) => {
        calls.push([command, ...args].join(' '));
        return { status: 0, stdout: 'bootstrapped\n', stderr: '' };
      },
    });

    expect(linux.command).toEqual(['systemctl', '--user', 'enable', '--now', 'olympus-worker.service']);
    expect(darwin.command[0]).toBe('launchctl');
    expect(darwin.command[1]).toBe('bootstrap');
    expect(darwin.command.at(-1)).toBe('/Users/friend/Library/LaunchAgents/com.openclaw.olympus.worker.plist');
    expect(calls).toContain('systemctl --user daemon-reload');
    expect(calls).toContain('systemctl --user enable --now olympus-worker.service');
    expect(calls.some((call) => call.startsWith('launchctl bootstrap gui/'))).toBe(true);
  });

  test('reloads the Linux user systemd manager before enabling the worker service', () => {
    const calls: string[] = [];
    const result = runWorkerServiceAction('install', {
      platform: 'linux',
      homeDir: '/home/friend',
      exec: (command, args) => {
        calls.push([command, ...args].join(' '));
        if (args.join(' ') === '--user daemon-reload') return { status: 0, stdout: 'reloaded\n', stderr: '' };
        if (args.join(' ') === '--user enable --now olympus-worker.service') return { status: 0, stdout: 'enabled\n', stderr: '' };
        return { status: 1, stdout: '', stderr: 'unexpected systemctl call' };
      },
    });

    expect(calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now olympus-worker.service',
    ]);
    expect(result.command).toEqual(['systemctl', '--user', 'enable', '--now', 'olympus-worker.service']);
    expect(result.stdout).toBe('reloaded\nenabled\n');
  });

  test('replaces an already-loaded macOS worker service during install', () => {
    const calls: string[] = [];
    const result = runWorkerServiceAction('install', {
      platform: 'darwin',
      homeDir: '/Users/friend',
      exec: (command, args) => {
        const call = [command, ...args].join(' ');
        calls.push(call);
        if (args[0] === 'print') return { status: 0, stdout: 'loaded\n', stderr: '' };
        if (args[0] === 'bootout') return { status: 0, stdout: 'unloaded\n', stderr: '' };
        if (args[0] === 'bootstrap') return { status: 0, stdout: 'bootstrapped\n', stderr: '' };
        return { status: 1, stdout: '', stderr: `unexpected ${call}` };
      },
    });

    expect(calls[0]).toMatch(/^launchctl print gui\/\d+\/com\.openclaw\.olympus\.worker$/);
    expect(calls[1]).toMatch(/^launchctl bootout gui\/\d+\/com\.openclaw\.olympus\.worker$/);
    expect(calls[2]).toMatch(/^launchctl bootstrap gui\/\d+ \/Users\/friend\/Library\/LaunchAgents\/com\.openclaw\.olympus\.worker\.plist$/);
    expect(result.command[1]).toBe('bootstrap');
    expect(result.stdout).toBe('loaded\nunloaded\nbootstrapped\n');
  });

  test('bootstraps macOS worker service when no existing service is loaded', () => {
    const calls: string[] = [];
    const result = runWorkerServiceAction('install', {
      platform: 'darwin',
      homeDir: '/Users/friend',
      exec: (command, args) => {
        const call = [command, ...args].join(' ');
        calls.push(call);
        if (args[0] === 'print') return { status: 3, stdout: '', stderr: 'not loaded\n' };
        if (args[0] === 'bootstrap') return { status: 0, stdout: 'bootstrapped\n', stderr: '' };
        return { status: 1, stdout: '', stderr: `unexpected ${call}` };
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^launchctl print gui\/\d+\/com\.openclaw\.olympus\.worker$/);
    expect(calls[1]).toMatch(/^launchctl bootstrap gui\/\d+ \/Users\/friend\/Library\/LaunchAgents\/com\.openclaw\.olympus\.worker\.plist$/);
    expect(calls.some((call) => call.includes('bootout'))).toBe(false);
    expect(result.command[1]).toBe('bootstrap');
    expect(result.stdout).toBe('bootstrapped\n');
  });
});


test('worker.env is written with owner-only permissions (token file)', async () => {
  const { mkdtempSync, readFileSync, statSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { installWorkerService } = await import('../src/core/worker-service.ts');
  const home = mkdtempSync(join(tmpdir(), 'olympus-worker-env-perms-'));
  try {
    installWorkerService({ platform: 'darwin', homeDir: home, authToken: 'test-token', dryRun: false });
    const envPath = join(home, '.config', 'olympus', 'worker.env');
    const mode = statSync(envPath).mode & 0o777;
    const env = readFileSync(envPath, 'utf8');
    expect(mode).toBe(0o600);
    expect(env).toContain(`PATH=${dirname(process.execPath)}`);
    expect(env).toContain('/usr/local/bin');
    expect(env).toContain('/usr/bin');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('worker.env placeholder is upgraded when install receives a generated token', async () => {
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { installWorkerService } = await import('../src/core/worker-service.ts');
  const home = mkdtempSync(join(tmpdir(), 'olympus-worker-env-upgrade-'));
  const envPath = join(home, '.config', 'olympus', 'worker.env');
  try {
    mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
    writeFileSync(envPath, '# Olympus source worker environment.\n# OLYMPUS_WORKER_AUTH_TOKEN=replace-with-generated-token\n', { mode: 0o600 });
    const result = installWorkerService({
      platform: 'linux',
      homeDir: home,
      authToken: 'generated-token',
      dryRun: false,
    });
    const env = readFileSync(envPath, 'utf8');

    expect(result.wrote_env).toBe(true);
    expect(env).toContain('OLYMPUS_WORKER_AUTH_TOKEN=generated-token');
    expect(env).not.toContain('replace-with-generated-token');
    expect(env).toContain(`PATH=${dirname(process.execPath)}`);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('worker.env enables source_answer by default and preserves an explicit operator setting', async () => {
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { installWorkerService } = await import('../src/core/worker-service.ts');
  const home = mkdtempSync(join(tmpdir(), 'olympus-worker-env-answer-flag-'));
  const envPath = join(home, '.config', 'olympus', 'worker.env');
  try {
    // Fresh install: flag present and enabled.
    let result = installWorkerService({ platform: 'linux', homeDir: home, authToken: 'token-a', dryRun: false });
    expect(result.wrote_env).toBe(true);
    expect(readFileSync(envPath, 'utf8')).toContain('OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED=true');

    // Pre-existing env without the flag: appended on reinstall.
    writeFileSync(envPath, 'PATH=/custom/bin\nOLYMPUS_WORKER_AUTH_TOKEN=old-token\n', { mode: 0o600 });
    result = installWorkerService({ platform: 'linux', homeDir: home, authToken: 'token-b', dryRun: false });
    expect(result.wrote_env).toBe(true);
    expect(readFileSync(envPath, 'utf8')).toContain('OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED=true');

    // Explicit operator opt-out survives reinstall.
    writeFileSync(envPath, 'OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED=false\nOLYMPUS_WORKER_AUTH_TOKEN=old-token\n', { mode: 0o600 });
    installWorkerService({ platform: 'linux', homeDir: home, authToken: 'token-c', dryRun: false });
    const env = readFileSync(envPath, 'utf8');
    expect(env).toContain('OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED=false');
    expect(env).not.toContain('OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED=true');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('worker.env PATH is repaired without dropping existing entries', async () => {
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { installWorkerService } = await import('../src/core/worker-service.ts');
  const home = mkdtempSync(join(tmpdir(), 'olympus-worker-env-path-'));
  const envPath = join(home, '.config', 'olympus', 'worker.env');
  try {
    mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
    writeFileSync(envPath, 'PATH=/custom/bin\nOLYMPUS_WORKER_AUTH_TOKEN=old-token\n', { mode: 0o600 });

    const result = installWorkerService({
      platform: 'linux',
      homeDir: home,
      authToken: 'new-token',
      dryRun: false,
    });
    const env = readFileSync(envPath, 'utf8');
    const pathLine = env.match(/^PATH=(.+)$/m)?.[1] ?? '';

    expect(result.wrote_env).toBe(true);
    expect(pathLine.split(':')).toContain(dirname(process.execPath));
    expect(pathLine.split(':')).toContain('/custom/bin');
    expect(pathLine.split(':')).toContain('/usr/local/bin');
    expect(pathLine.split(':')).toContain('/usr/bin');
    expect(env).toContain('OLYMPUS_WORKER_AUTH_TOKEN=old-token');
    expect(env).not.toContain('new-token');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('active worker.env placeholder is replaced when install receives a generated token', async () => {
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { installWorkerService } = await import('../src/core/worker-service.ts');
  const home = mkdtempSync(join(tmpdir(), 'olympus-worker-env-active-placeholder-'));
  const envPath = join(home, '.config', 'olympus', 'worker.env');
  try {
    mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
    writeFileSync(envPath, 'OLYMPUS_WORKER_AUTH_TOKEN=replace-with-generated-token\n', { mode: 0o600 });
    const result = installWorkerService({
      platform: 'linux',
      homeDir: home,
      authToken: 'generated-token',
      dryRun: false,
    });
    const env = readFileSync(envPath, 'utf8');

    expect(result.wrote_env).toBe(true);
    expect(env).toContain('OLYMPUS_WORKER_AUTH_TOKEN=generated-token');
    expect(env).not.toContain('replace-with-generated-token');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('worker.env permissions are repaired when an existing token is preserved', async () => {
  const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { installWorkerService } = await import('../src/core/worker-service.ts');
  const home = mkdtempSync(join(tmpdir(), 'olympus-worker-env-repair-'));
  const envPath = join(home, '.config', 'olympus', 'worker.env');
  try {
    mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
    writeFileSync(envPath, 'OLYMPUS_WORKER_AUTH_TOKEN=old-token\n', { mode: 0o644 });
    chmodSync(envPath, 0o644);

    const result = installWorkerService({
      platform: 'linux',
      homeDir: home,
      authToken: 'new-token',
      dryRun: false,
    });

    expect(result.wrote_env).toBe(true);
    expect(readFileSync(envPath, 'utf8')).toContain('OLYMPUS_WORKER_AUTH_TOKEN=old-token');
    expect(readFileSync(envPath, 'utf8')).not.toContain('new-token');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
