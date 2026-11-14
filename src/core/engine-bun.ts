/**
 * The Bun an engine runs on. A fresh install brings its own pinned Bun; an
 * install made with `olympus worker install` runs on whatever Bun ran that
 * command, which on an older machine is the machine's own. Bun before 1.4.4
 * corrupts its heap when workers open and close SQLite at once (#1523), and
 * rejects store opens the engine now makes, so the worker install and
 * upgrade find a Bun at least this new before anything stops, switch to it,
 * and write it into the unit; with none, they say so and change nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { OperationError } from './operation-error.ts';

/** Equal to `.bun-version`, CI's bun-version and the installers' pin (test/engine-bun.test.ts). */
export const ENGINE_BUN_MINIMUM = '1.4.4';

function parts(version: string): number[] {
  return version.trim().replace(/^v/, '').split(/[-+]/)[0]!.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

export function bunVersionAtLeast(version: string, minimum = ENGINE_BUN_MINIMUM): boolean {
  const have = parts(version);
  const need = parts(minimum);
  for (let index = 0; index < Math.max(have.length, need.length); index += 1) {
    const a = have[index] ?? 0;
    const b = need[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export function bunVersionOf(bin: string): string | undefined {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  const version = result.status === 0 ? result.stdout.trim() : '';
  return /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
}

/** The running Bun when this is Bun, else undefined. */
export function runningBun(): { path: string; version: string } | undefined {
  if (typeof Bun === 'undefined') return undefined;
  return { path: process.execPath, version: Bun.version };
}

/**
 * The first Bun at least ENGINE_BUN_MINIMUM: the one asked for (and only it),
 * else the running one, the one on PATH, then Bun's own install places.
 */
export function resolveEngineBun(input: {
  bunBin?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  version?: (bin: string) => string | undefined;
} = {}): { path: string; version: string } {
  const env = input.env ?? process.env;
  const version = input.version ?? bunVersionOf;
  const running = runningBun();
  const candidates = input.bunBin
    ? [input.bunBin]
    : [
      running?.path,
      typeof Bun !== 'undefined' ? Bun.which('bun') ?? undefined : undefined,
      env.BUN_INSTALL ? join(env.BUN_INSTALL, 'bin', 'bun') : undefined,
      join(input.homeDir ?? homedir(), '.bun', 'bin', 'bun'),
    ];
  const seen: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || seen.some((entry) => entry.startsWith(`${candidate} `))) continue;
    if (!existsSync(candidate)) { if (input.bunBin) seen.push(`${candidate} (missing)`); continue; }
    const found = candidate === running?.path ? running.version : version(candidate);
    seen.push(`${candidate} (${found ?? 'did not run'})`);
    if (found && bunVersionAtLeast(found)) return { path: candidate, version: found };
  }
  throw new OperationError(
    'config_error',
    `Olympus needs Bun ${ENGINE_BUN_MINIMUM} or newer to run its engine, and the Bun found is older: ${seen.join(', ') || 'none'}. Nothing was changed.`,
    `Install Bun ${ENGINE_BUN_MINIMUM} (curl -fsSL https://bun.sh/install | bash -s "bun-v${ENGINE_BUN_MINIMUM}"), then run this again with --bun ~/.bun/bin/bun.`,
  );
}
