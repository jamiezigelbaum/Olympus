/**
 * Which `src/**` modules the public product actually reaches.
 *
 * The public product is what `scripts/release-artifact.ts` builds: the runtime
 * entrypoints below, bundled with `PUBLIC_RUNTIME_BUILD = true` and the
 * `OLYMPUS_PUBLIC_RUNTIME_EXCLUDE` spans stripped from the modules listed in
 * `scripts/public-runtime-strip.ts`. Anything in `src/` that no entrypoint
 * imports after that strip is not in the product. It may be tooling reached
 * only by a repository script, a planned feature that is not wired yet, or a
 * leftover — but it is not something a user installs.
 *
 * Reachability follows runtime imports only, which is what the bundle carries.
 * A module consumed purely as types (`import type`) is erased at build time;
 * such modules are allowlisted with that stated reason rather than counted as
 * reachable, because counting them would also count everything *they* import
 * as product when none of it ships.
 *
 * `test/public-surface-guard.test.ts` requires every unreachable module to be
 * named in `config/public-surface-allowlist.json` with a reason, and every
 * allowlist entry to still be unreachable, so the list only shrinks.
 *
 * Usage:
 *   bun scripts/public-surface-reach.ts          # unreachable modules, one per line
 *   bun scripts/public-surface-reach.ts --json   # { entrypoints, reachable, unreachable }
 */
import { Glob } from 'bun';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { PUBLIC_RUNTIME_STRIPPED_MODULES, stripPublicRuntimeExcludedBlocks } from './public-runtime-strip.ts';

export const PUBLIC_ENTRYPOINTS = [
  'src/native-plugin.ts',
  'src/control-ui.ts',
  'src/cli.ts',
  'src/mcp/server.ts',
  'scripts/source-embedding-drain.ts',
] as const;

export interface PublicReachability {
  readonly entrypoints: readonly string[];
  readonly reachable: readonly string[];
  readonly unreachable: readonly string[];
}

const TYPE_ONLY_STATEMENT = /(?:^|[^\w$])(?:import|export)\s+type\s[^;]*?['"]\.[^'"]+['"]\s*;?/g;
const IMPORT_SPECIFIER = /(?:^|[^\w$])(?:import|export)\b[^'"]*?\bfrom\s*['"](\.[^'"]+)['"]|(?:^|[^\w$])import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|(?:^|[^\w$])import\s*['"](\.[^'"]+)['"]/g;

function resolveSpecifier(fromFile: string, specifier: string, repoRoot: string): string | undefined {
  const base = resolve(repoRoot, dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (candidate.endsWith('.ts') && existsSync(candidate)) return relative(repoRoot, candidate).split('\\').join('/');
  }
  return undefined;
}

export function publicReachability(repoRoot: string): PublicReachability {
  const stripped = new Set<string>(PUBLIC_RUNTIME_STRIPPED_MODULES);
  const all = [...new Glob('src/**/*.ts').scanSync({ cwd: repoRoot })]
    .map((path) => path.split('\\').join('/'))
    .filter((path) => !path.endsWith('.d.ts'))
    .sort();
  const reachable = new Set<string>();
  const stack: string[] = [...PUBLIC_ENTRYPOINTS];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (reachable.has(file)) continue;
    const absolute = join(repoRoot, file);
    if (!existsSync(absolute)) continue;
    reachable.add(file);
    let source = readFileSync(absolute, 'utf8');
    if (stripped.has(file)) source = stripPublicRuntimeExcludedBlocks(source, absolute);
    source = source.replace(TYPE_ONLY_STATEMENT, '');
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      const target = resolveSpecifier(file, specifier, repoRoot);
      if (target && !reachable.has(target)) stack.push(target);
    }
  }
  return {
    entrypoints: PUBLIC_ENTRYPOINTS,
    reachable: all.filter((path) => reachable.has(path)),
    unreachable: all.filter((path) => !reachable.has(path)),
  };
}

if (import.meta.main) {
  const report = publicReachability(join(import.meta.dir, '..'));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report.unreachable.join('\n'));
  }
}
