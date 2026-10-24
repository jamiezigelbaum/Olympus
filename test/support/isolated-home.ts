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
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import * as osModule from 'node:os';
import * as childProcessModule from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { afterAll, mock } from 'bun:test';

// One spelling per directory: a trailing slash, `..` or a symlink alias of a
// directory compares equal to the directory itself.
function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}
function isInside(path: string, root: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

// The account's home from the user database, keyed by the kernel's uid
// (`id -un`), never from HOME, USER or LOGNAME: Bun's os.userInfo() and
// os.homedir() both follow the environment.
const realHome = (() => {
  try {
    const out = childProcessModule.spawnSync('/bin/sh', ['-c', 'user=$(id -un) && eval echo "~$user"'], {
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    const resolved = String(out.stdout).trim();
    if (out.status === 0 && resolved.startsWith('/')) return canonical(resolved);
  } catch { /* no user database entry (a bare container user) */ }
  // Unknown: there is no account home to compare against. The temp-directory
  // rule below still holds.
  return '';
})();
// Bun reads HOME for os.homedir() once, at process start, and every descendant
// inherits the starting environment. A run that starts under the account's real
// HOME cannot be made safe from inside (a grandchild with a scrubbed env would
// find the real home again), so it does not run: start tests with an isolated
// HOME (the package scripts, scripts/test-lane.ts, or a HOME=<temp dir> prefix).
// When the account home cannot be found, only a temp directory is provably
// not it. OLYMPUS_TEST_REFUSE_HOME names one more home to refuse, so a test can
// prove the refusal without ever starting a run in the real home; it can only
// add refusals.
const startHome = canonical(process.env.HOME || homedir());
const refusedHomes = [realHome, process.env.OLYMPUS_TEST_REFUSE_HOME?.trim() ?? ''].filter(Boolean).map(canonical);
const startsInRealHome = refusedHomes.includes(startHome)
  || (!realHome && !isInside(startHome, canonical(tmpdir())) && !isInside(startHome, canonical('/tmp')));
if (startsInRealHome) {
  throw new Error(
    `Refusing to run tests with HOME=${startHome}: that is the real home, or a home that cannot be shown not to be. Use the package test scripts, or prefix HOME="$(mktemp -d)".`,
  );
}
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
// Not covered: a grandchild that a child starts with an empty environment. It
// has no HOME to inherit, and Bun then reads the account's home from the user
// database; only an OS-level sandbox could stop that.
type Env = Record<string, string | undefined>;
function isolatedChildEnv(env: Env): Env {
  const requested = env.HOME;
  if (requested && realHome && canonical(requested) === realHome) {
    throw new Error(`a test asked a child process to run with the real HOME ${realHome}`);
  }
  return requested ? env : { ...env, HOME: home };
}
// Any non-array object: plain, null-prototype (Object.create(null)) or class
// instances all carry an environment the same way.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fixOptions(options: Record<string, unknown>): Record<string, unknown> {
  const env = options.env;
  return isPlainObject(env) ? { ...options, env: isolatedChildEnv(env as Env) } : options;
}
function wrapPlain<T extends (...args: never[]) => unknown>(original: T): T {
  return ((...args: unknown[]) => (original as unknown as (...a: unknown[]) => unknown)(
    ...args.map((arg, index) => (index > 0 && isPlainObject(arg) ? fixOptions(arg) : arg)),
  )) as unknown as T;
}
function wrapSpawnLike<T extends (...args: never[]) => unknown>(original: T): T {
  const wrapped = wrapPlain(original);
  // util.promisify(execFile) must keep resolving to { stdout, stderr }: that
  // shape lives on the original's promisify.custom, which a plain wrapper loses.
  const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom];
  if (typeof custom === 'function') {
    Object.defineProperty(wrapped, promisify.custom, { value: wrapPlain(custom as never), configurable: true });
  }
  return wrapped;
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
