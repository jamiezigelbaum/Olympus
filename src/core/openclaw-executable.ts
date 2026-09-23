// One resolver for the `openclaw` executable, shared by every Olympus spawn of
// the OpenClaw CLI and by the worker-environment writer that records its
// directory on the managed worker's PATH.
//
// Incident 2026-09-23: a per-user OpenClaw install lived at ~/.local/bin
// (npm prefix ~/.local), which the managed worker PATH never included, so the
// cloud analyst's `openclaw infer` spawn failed on every Personal/Public
// answer. Setup now records the directory it can see, and the worker-side
// lookup checks the common per-user prefixes as well.

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export interface ResolveOpenClawExecutableOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  // Test seam; defaults to Bun.which against the current process PATH.
  which?: (command: string) => string | null;
}

/**
 * Absolute path of the `openclaw` executable, or undefined when none is found.
 * Order: OPENCLAW_BIN (explicit), the given env PATH, the current process PATH,
 * then well-known system and per-user install locations.
 */
export function resolveOpenClawExecutable(options: ResolveOpenClawExecutableOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const explicit = env.OPENCLAW_BIN?.trim();
  if (explicit && isAbsolute(explicit) && isExecutableFile(explicit)) return explicit;

  for (const entry of (env.PATH ?? '').split(delimiter)) {
    const directory = entry.trim();
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, 'openclaw');
    if (isExecutableFile(candidate)) return candidate;
  }

  const which = options.which ?? ((command: string) => (typeof Bun !== 'undefined' ? Bun.which(command) : null));
  const found = which('openclaw');
  if (found && isAbsolute(found)) return found;

  const home = options.homeDir?.trim() || env.HOME?.trim() || homedir();
  for (const candidate of openClawWellKnownPaths(home)) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export function openClawWellKnownPaths(home: string): string[] {
  return [
    '/opt/homebrew/bin/openclaw',
    '/usr/local/bin/openclaw',
    join(home, '.local', 'bin', 'openclaw'),
    join(home, '.npm-global', 'bin', 'openclaw'),
    join(home, '.openclaw', 'bin', 'openclaw'),
    join(home, '.bun', 'bin', 'openclaw'),
  ];
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
