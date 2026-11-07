import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installManagedWorkerFiles } from '../src/core/lifecycle.ts';
import { installWorkerService } from '../src/core/worker-service.ts';
import { WORKER_CLI_LAUNCHER_MARKER, workerCliLauncherPath } from '../src/core/worker-cli-launcher.ts';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function homeFixture() {
  // Shell metacharacters in a legitimate path must stay literal.
  const home = mkdtempSync(join(tmpdir(), "olympus cli's $home-"));
  homes.push(home);
  return home;
}
function cliFixture(home: string, version: string) {
  const root = join(home, version);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist/cli.js'), `console.log(JSON.stringify({version:${JSON.stringify(version)},args:process.argv.slice(2),cwd:process.cwd()}));`);
  return root;
}
function run(command: string[], home: string) {
  return Bun.spawnSync(command, { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' });
}

describe('OpenClaw worker CLI launcher', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    test(`${platform} setup leaves an owner-only command in a new login shell, without Bun on PATH`, () => {
      const home = homeFixture();
      const root = cliFixture(home, 'installed');
      const result = installManagedWorkerFiles({ platform, homeDir: home, workingDirectory: root, activate: false });
      const path = workerCliLauncherPath(home);
      expect(result.install.wrote_launcher).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
      expect(readFileSync(path, 'utf8').split('\n')[1]).toBe(WORKER_CLI_LAUNCHER_MARKER);
      writeFileSync(join(home, '.profile'), 'PATH="$HOME/.local/bin:/usr/bin:/bin"; export PATH\n');
      // The caller's own directory is kept, so a relative argument (an export's --output) means what the caller meant.
      const launched = run(['/bin/sh', '-lc', 'cd "$HOME" && command -v olympus && olympus dashboard "two words"'], home);
      expect(launched.exitCode, launched.stderr.toString()).toBe(0);
      const lines = launched.stdout.toString().trim().split('\n');
      expect(lines[0]).toBe(path);
      expect(JSON.parse(lines[1]!)).toEqual({ version: 'installed', args: ['dashboard', 'two words'], cwd: home });

      // Updating the plugin's location retargets only our launcher.
      const upgraded = cliFixture(home, 'upgraded');
      const options = { platform, homeDir: home, workingDirectory: upgraded };
      expect(installWorkerService(options).wrote_launcher).toBe(true);
      expect(installWorkerService(options).wrote_launcher).toBe(false);
      const again = run([path, '--version'], home);
      expect(again.exitCode, again.stderr.toString()).toBe(0);
      expect(JSON.parse(again.stdout.toString()).version).toBe('upgraded');
      chmodSync(path, 0o755);
      expect(installWorkerService(options).wrote_launcher).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
    }, 30_000);

    test(`${platform} gives an executable full command when the login PATH omits ~/.local/bin`, () => {
      const home = homeFixture();
      const root = cliFixture(home, 'installed');
      const result = installWorkerService({ platform, homeDir: home, workingDirectory: root });
      writeFileSync(join(home, '.profile'), 'PATH=/usr/bin:/bin; export PATH\n');
      expect(run(['/bin/sh', '-lc', 'command -v olympus'], home).exitCode).not.toBe(0);
      const launched = run(['/bin/sh', '-lc', `${result.cli_command} dashboard`], home);
      expect(launched.exitCode, launched.stderr.toString()).toBe(0);
      expect(JSON.parse(launched.stdout.toString()).args).toEqual(['dashboard']);
      expect(result.notices.join('\n')).toContain(`${result.cli_command} dashboard`);
    }, 30_000);
  }

  test.each(['user', 'standalone', 'symlink', 'dangling symlink', 'directory'])('preserves a %s launcher', (kind) => {
    const home = homeFixture();
    const root = cliFixture(home, 'installed');
    const path = workerCliLauncherPath(home);
    mkdirSync(dirname(path), { recursive: true });
    const target = join(home, 'target');
    writeFileSync(target, '#!/bin/sh\n# owner launcher\n');
    if (kind === 'symlink' || kind === 'dangling symlink') symlinkSync(kind === 'symlink' ? target : join(home, 'absent'), path);
    else if (kind === 'directory') mkdirSync(path);
    else writeFileSync(path, kind === 'standalone' ? '#!/bin/sh\n# standalone engine launcher\n' : '#!/bin/sh\necho mine\n', { mode: 0o755 });
    const stat = lstatSync(path);
    const bytes = stat.isFile() ? readFileSync(path, 'utf8') : undefined;
    const result = installWorkerService({ platform: 'linux', homeDir: home, workingDirectory: root });
    expect(result.wrote_launcher).toBe(false);
    expect(lstatSync(path).ino).toBe(stat.ino);
    expect(lstatSync(path).mode).toBe(stat.mode);
    if (bytes) expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\n# owner launcher\n');
    expect(result.notices.join('\n')).toContain('Kept the existing');
    const fallback = run(['/bin/sh', '-c', `${result.cli_command} dashboard`], home);
    expect(fallback.exitCode, fallback.stderr.toString()).toBe(0);
  });

  test('refuses a symlinked launcher parent and leaves the destination untouched', () => {
    const home = homeFixture();
    const root = cliFixture(home, 'installed');
    const outside = join(home, 'outside');
    mkdirSync(outside);
    mkdirSync(join(home, '.local'));
    symlinkSync(outside, join(home, '.local/bin'));
    expect(() => installManagedWorkerFiles({ platform: 'linux', homeDir: home, workingDirectory: root, activate: false })).toThrow();
    expect(existsSync(join(outside, 'olympus'))).toBe(false);
  });

  test('dry run leaves no launcher or home directories', () => {
    const home = join(homeFixture(), 'absent');
    const result = installWorkerService({ platform: 'darwin', homeDir: home, dryRun: true });
    expect(result.wrote_launcher).toBe(false);
    expect(existsSync(home)).toBe(false);
  });
});
