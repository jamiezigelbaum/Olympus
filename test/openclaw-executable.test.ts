import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';
import { resolveOpenClawExecutable } from '../src/core/openclaw-executable.ts';
import { installWorkerService } from '../src/core/worker-service.ts';

function placeExecutable(home: string, relative: string): string {
  const path = join(home, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
}

test('worker.env PATH carries the directory of the resolvable openclaw executable', () => {
  const home = mkdtempSync(join(tmpdir(), 'olympus-worker-env-openclaw-'));
  const envPath = join(home, '.config', 'olympus', 'worker.env');
  // Incident 2026-09-23: a per-user OpenClaw at ~/.local/bin was off the
  // managed worker PATH, so every cloud-analyst spawn failed.
  const openclawBin = placeExecutable(home, '.local/bin/openclaw');
  const userBin = dirname(openclawBin);
  try {
    installWorkerService({ platform: 'linux', homeDir: home, authToken: 'token', openclawBin, dryRun: false });
    let pathLine = readFileSync(envPath, 'utf8').match(/^PATH=(.+)$/m)?.[1] ?? '';
    expect(pathLine.split(':')[0]).toBe(dirname(process.execPath));
    expect(pathLine.split(':')).toContain(userBin);

    // A worker.env written by an older install is repaired in place.
    writeFileSync(envPath, 'PATH=/custom/bin\nOLYMPUS_WORKER_AUTH_TOKEN=old-token\n', { mode: 0o600 });
    installWorkerService({ platform: 'linux', homeDir: home, authToken: 'token', openclawBin, dryRun: false });
    pathLine = readFileSync(envPath, 'utf8').match(/^PATH=(.+)$/m)?.[1] ?? '';
    expect(pathLine.split(':')).toContain(userBin);
    expect(pathLine.split(':')).toContain('/custom/bin');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('openclaw resolution honors OPENCLAW_BIN, then PATH, then per-user install prefixes', () => {
  const home = mkdtempSync(join(tmpdir(), 'olympus-openclaw-resolve-'));
  const noWhich = () => null;
  try {
    expect(resolveOpenClawExecutable({ env: { PATH: '' }, homeDir: home, which: noWhich })).toBeUndefined();

    const userLocal = placeExecutable(home, '.local/bin/openclaw');
    expect(resolveOpenClawExecutable({ env: { PATH: '' }, homeDir: home, which: noWhich })).toBe(userLocal);

    const onPath = placeExecutable(home, 'path-bin/openclaw');
    expect(resolveOpenClawExecutable({ env: { PATH: dirname(onPath) }, homeDir: home, which: noWhich })).toBe(onPath);

    const explicit = placeExecutable(home, 'explicit/openclaw');
    expect(resolveOpenClawExecutable({
      env: { PATH: dirname(onPath), OPENCLAW_BIN: explicit },
      homeDir: home,
      which: noWhich,
    })).toBe(explicit);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
