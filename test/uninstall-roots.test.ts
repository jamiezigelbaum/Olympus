/**
 * The uninstall scripts run no Olympus code, so each spells the folders it
 * deals with itself; the layout module's `olympusUninstallRoots` is the one
 * list of them (docs/design/source-storage.md, "Export and uninstall"). The
 * macOS uninstaller names every one of them as kept, and the standalone Linux
 * purge removes exactly the install's own.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';
import { olympusUninstallRoots } from '../src/core/olympus-layout.ts';

const REPO = join(import.meta.dir, '..');

/** The words of the macOS uninstaller's kept-folder loop, between `for kept in` and `; do`. */
function macKeptList(): string {
  const script = readFileSync(join(REPO, 'site', 'uninstall.sh'), 'utf8');
  const start = script.indexOf('for kept in \\');
  const end = script.indexOf('; do', start);
  expect(start).toBeGreaterThan(-1);
  return script.slice(start + 'for kept in'.length, end);
}

/** The folders that loop names under an environment, as the shell expands them. */
function macKept(env: Record<string, string>): string[] {
  const result = spawnSync('/bin/sh', ['-c', `LOGDIR="$HOME/Library/Logs/Olympus"; for kept in ${macKeptList()}; do printf '%s\\n' "$kept"; done`], {
    env: { PATH: '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return [...new Set(result.stdout.split('\n').filter(Boolean))];
}

describe('the uninstall scripts name the layout module\'s folders', () => {
  for (const [name, env] of [
    ['default homes', { HOME: '/home/owner' }],
    ['every XDG home moved', { HOME: '/home/owner', XDG_DATA_HOME: '/xdg/data', XDG_STATE_HOME: '/xdg/state', XDG_CACHE_HOME: '/xdg/cache' }],
  ] as const) {
    test(`macOS lists every folder it keeps (${name})`, () => {
      expect(macKept(env).sort()).toEqual(olympusUninstallRoots(env, 'darwin').sort());
    });
  }

  test('the macOS list covers the folders the design found missing', () => {
    const roots = olympusUninstallRoots({ HOME: '/home/owner' }, 'darwin');
    for (const folder of ['.local/share/olympus', '.local/state/olympus', '.cache/olympus']) {
      expect(roots).toContain(join('/home/owner', folder));
    }
  });

  test('the Linux purge removes exactly the install\'s own folders', () => {
    const script = readFileSync(join(REPO, 'site', 'uninstall-linux.sh'), 'utf8');
    const purge = /roots = sorted\(set\(\[(.*?)\]\), key=/.exec(script);
    expect(purge).not.toBeNull();
    const keys = [...purge![1]!.matchAll(/layout\["(\w+)"\]/g)].map((match) => match[1]!);
    // The config folder is emptied last, once everything else is gone (the receipt lives there).
    expect(script).toContain('for name in os.listdir(layout["configDir"]):');
    const env = { HOME: '/home/owner', XDG_DATA_HOME: '/xdg/data', XDG_STATE_HOME: '/xdg/state', XDG_CACHE_HOME: '/xdg/cache', XDG_CONFIG_HOME: '/xdg/config' };
    const layout = resolveLinuxEngineLayout(env) as unknown as Record<string, string>;
    expect([layout.configDir, ...keys.map((key) => layout[key])].sort()).toEqual(olympusUninstallRoots(env, 'linux').sort());
  });
});
