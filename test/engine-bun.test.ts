// The engine runs on the Bun written into its unit. A worker install made on
// an older machine wrote the machine's own Bun there (1.3.14 on the gate7 VM
// and Sparta, which corrupts its heap under worker SQLite churn and refused
// rc.12's store copy), so the install and upgrade now find a Bun at least the
// pinned one before anything stops, or say so and change nothing.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_BUN_MINIMUM, bunVersionAtLeast, resolveEngineBun } from '../src/core/engine-bun.ts';

const ROOT = join(import.meta.dir, '..');

describe('the Bun an engine runs on', () => {
  test('the minimum is the pinned Bun everywhere it is pinned', () => {
    expect(readFileSync(join(ROOT, '.bun-version'), 'utf8').trim()).toBe(ENGINE_BUN_MINIMUM);
    const ci = [...readFileSync(join(ROOT, '.github/workflows/verify.yml'), 'utf8').matchAll(/bun-version: (\S+)/g)].map((m) => m[1]);
    expect(ci.length).toBeGreaterThan(0);
    expect(new Set(ci)).toEqual(new Set([ENGINE_BUN_MINIMUM]));
    expect(readFileSync(join(ROOT, 'scripts/install-macos.sh'), 'utf8')).toContain(`BUN_VERSION=${ENGINE_BUN_MINIMUM}\n`);
  });

  test('versions compare by number', () => {
    expect(bunVersionAtLeast('1.3.14')).toBe(false);
    expect(bunVersionAtLeast('1.4.4')).toBe(true);
    expect(bunVersionAtLeast('1.4.10')).toBe(true);
    expect(bunVersionAtLeast('1.10.0')).toBe(true);
    expect(bunVersionAtLeast('1.4.5-canary.1+abc')).toBe(true);
  });

  test('an older Bun asked for is refused, naming it; nothing else is tried', () => {
    expect(() => resolveEngineBun({ bunBin: process.execPath, version: () => '1.3.14', homeDir: tmpdir() })).not.toThrow();
    const old = join(mkdtempSync(join(tmpdir(), 'olympus-old-bun-')), 'bun');
    symlinkSync(process.execPath, old);
    expect(() => resolveEngineBun({ bunBin: old, version: () => '1.3.14', homeDir: tmpdir() })).toThrow(/needs Bun 1\.4\.4 or newer.*1\.3\.14.*Nothing was changed/);
  });
});

// CI's deploy shard sets OLDEST_INSTALL_BUN to the oldest Bun an existing install
// can have (1.3.14), so the first step of an upgrade is proven on it.
const OLD_BUN = process.env.OLDEST_INSTALL_BUN;
describe.skipIf(!OLD_BUN)('the upgrade started on the oldest Bun an install can have', () => {
  const cli = join(ROOT, 'dist/cli.js');
  const run = (args: string[], env: Record<string, string>) => spawnSync(OLD_BUN!, ['--no-env-file', cli, 'worker', ...args], { encoding: 'utf8', env: { ...process.env, BUN_INSTALL: '', ...env } });

  test('with only the old Bun, it says so and changes nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-old-bun-home-'));
    const result = run(['upgrade', '--artifact', join(home, 'olympus.tgz'), '--home', home, '--bun', OLD_BUN!], { HOME: mkdtempSync(join(tmpdir(), 'olympus-old-bun-env-')) });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(`needs Bun ${ENGINE_BUN_MINIMUM} or newer`);
    expect(readdirSync(home)).toEqual([]);
  });

  test('with the pinned Bun on the machine, it moves onto it before anything else', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-old-bun-home-'));
    mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
    symlinkSync(process.execPath, join(home, '.bun', 'bin', 'bun'));
    const bin = mkdtempSync(join(tmpdir(), 'olympus-old-bun-path-'));
    symlinkSync(OLD_BUN!, join(bin, 'bun'));
    const result = run(['upgrade', '--artifact', join(home, 'missing.tgz'), '--home', home, '--dry-run'], { HOME: home, PATH: `${bin}:/usr/bin:/bin` });
    expect(result.stderr).toContain(`running this upgrade on Bun ${Bun.version} (${join(home, '.bun', 'bin', 'bun')})`);
    expect(existsSync(join(home, '.olympus'))).toBe(false);
  });
});
