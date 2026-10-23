/**
 * Test preload: every test runs against a throwaway HOME, XDG tree and
 * temp dir, never the owner's real one. A test that forgets to isolate itself
 * (2026-10-23: a delete fixture overwrote the live Dropbox store because the
 * resolver reads os.homedir(), not the env the fixture passed) writes into
 * this directory and nothing else.
 *
 * Also clears OLYMPUS_* and XDG_* so an ambient engine/worker setting cannot steer a
 * test onto the real data. A test that needs a variable sets it itself.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import * as osModule from 'node:os';
import * as childProcessModule from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, mock } from 'bun:test';

const realHome = (() => { try { return userInfo().homedir; } catch { return process.env.HOME ?? ''; } })();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'olympus-test-home-')));
const home = join(root, 'home');
mkdirSync(home, { recursive: true });

process.env.HOME = home;
// XDG roots are unset, not redirected: every default then derives from the
// throwaway HOME, and a test that passes its own homeDir still gets its own tree.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('OLYMPUS_') || name.startsWith('XDG_')) delete process.env[name];
}
process.env.OLYMPUS_TEST_ISOLATED_HOME = home;
process.env.OLYMPUS_TEST_REAL_HOME = realHome;

// Bun reads HOME for os.homedir() once, at process start, so changing the env
// here is not enough: make every os.homedir() (ESM import and require) follow
// the live HOME, which is now the throwaway one.
const liveHome = () => process.env.HOME ?? home;
const osCopy = { ...osModule } as Record<string, unknown>;
mock.module('node:os', () => ({ ...osCopy, default: { ...osCopy, homedir: liveHome }, homedir: liveHome }));
try { (createRequire(import.meta.url)('node:os') as { homedir: () => string }).homedir = liveHome; } catch { /* import form above still covers ESM */ }

// A child that names its own environment (env: { PATH }) would otherwise start
// with no HOME, and a Bun child resolves the real account home from the OS.
// Every spawn made from a test gets the isolated HOME when its env has none,
// and a child asked to run against the real home is refused.
type Env = Record<string, string | undefined>;
function isolatedChildEnv(env: Env): Env {
  const requested = env.HOME;
  if (requested && realHome && requested === realHome) {
    throw new Error(`a test asked a child process to run with the real HOME ${realHome}`);
  }
  return requested ? env : { ...env, HOME: home };
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
function fixOptions(options: Record<string, unknown>): Record<string, unknown> {
  const env = options.env;
  return isPlainObject(env) ? { ...options, env: isolatedChildEnv(env as Env) } : options;
}
function wrapSpawnLike<T extends (...args: never[]) => unknown>(original: T): T {
  return ((...args: unknown[]) => (original as unknown as (...a: unknown[]) => unknown)(
    ...args.map((arg, index) => (index > 0 && isPlainObject(arg) ? fixOptions(arg) : arg)),
  )) as unknown as T;
}
const cpCopy = { ...childProcessModule } as Record<string, unknown>;
const cpNames = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
for (const name of cpNames) {
  const original = cpCopy[name];
  if (typeof original === 'function') cpCopy[name] = wrapSpawnLike(original as never);
}
mock.module('node:child_process', () => ({ ...cpCopy, default: { ...cpCopy } }));
try {
  const cjs = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;
  for (const name of cpNames) if (typeof cjs[name] === 'function') cjs[name] = cpCopy[name];
} catch { /* the import form above still covers ESM */ }
const bunGlobal = (globalThis as { Bun?: { spawn?: unknown; spawnSync?: unknown } }).Bun;
if (bunGlobal) {
  for (const name of ['spawn', 'spawnSync'] as const) {
    const original = bunGlobal[name];
    if (typeof original !== 'function') continue;
    const wrapped = (...args: unknown[]) => {
      const fixed = args.map((arg, index) => {
        if (!isPlainObject(arg)) return arg;
        // Bun.spawn(cmd, options) or Bun.spawn({ cmd, ...options })
        return index === 0 && !('cmd' in arg) ? arg : fixOptions(arg);
      });
      return (original as (...a: unknown[]) => unknown).apply(bunGlobal, fixed);
    };
    try { bunGlobal[name] = wrapped; } catch { /* a frozen Bun leaves this one unwrapped */ }
  }
}

afterAll(() => {
  if (realHome && homedir() === realHome) {
    throw new Error(`a test moved HOME back to the real home ${realHome}; tests must never run against it`);
  }
});
process.once('exit', () => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});
