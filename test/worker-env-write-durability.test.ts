// worker.env is the only persistent home of the worker auth token in a default
// install, and its PATH line is what lets the macOS worker spawn openclaw. The
// upgrade-migration rewrites reopened the live path with O_TRUNC, so a reader
// landing mid-write — src/native-plugin.ts, doctor, the email CLI commands all
// read this file at runtime — saw a partial file, and a crash left one behind.
// Crash ordering cannot be exercised in-process, so what is pinned here is that
// the rewrites go through the shared flushing writer rather than a truncating
// write of the live path.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { installWorkerService } from '../src/core/worker-service.ts';

const WRITER_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'src', 'core', 'worker-service.ts'),
  'utf8',
);

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('worker.env write durability', () => {
  test('never truncates the live env path in place', () => {
    expect(WRITER_SOURCE.includes('writePrivateFileAtomicSync'), 'flushing writer used').toBe(true);
    expect(/writeFileSync\(\s*envPath/.test(WRITER_SOURCE), 'no truncating write of the live path')
      .toBe(false);
  });

  test('an upgrade rewrite leaves one private env file and no temp behind', () => {
    const home = tempHome();
    const envDir = join(home, '.config', 'olympus');
    const envPath = join(envDir, 'worker.env');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(envPath, 'PATH=/custom/bin\n# OLYMPUS_WORKER_AUTH_TOKEN=replace-with-generated-token\n', { mode: 0o600 });

    const result = installWorkerService({
      platform: 'linux',
      homeDir: home,
      authToken: 'generated-token',
      dryRun: false,
    });
    const env = readFileSync(envPath, 'utf8');

    expect(result.wrote_env).toBe(true);
    expect(readdirSync(envDir)).toEqual(['worker.env']);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(env).toContain('OLYMPUS_WORKER_AUTH_TOKEN=generated-token');
    expect(env).toContain('OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED=true');
    expect(env).toContain('/custom/bin');
  });

  test('a fresh install writes the env file privately with no temp behind', () => {
    const home = tempHome();
    const envDir = join(home, '.config', 'olympus');

    installWorkerService({ platform: 'linux', homeDir: home, authToken: 'fresh-token', dryRun: false });

    expect(readdirSync(envDir)).toEqual(['worker.env']);
    expect(statSync(join(envDir, 'worker.env')).mode & 0o777).toBe(0o600);
  });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'olympus-worker-env-durability-'));
  homes.push(home);
  return home;
}
