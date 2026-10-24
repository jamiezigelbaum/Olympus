// The layout module is the one place that computes the data root
// (docs/design/source-storage.md, step 1). These pin what it returns and keep
// a new module from rebuilding the expression inline, which is how the store
// paths drifted apart in the first place.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  legacyCaptureDataRoot,
  legacyTelegramStoreRoot,
  layoutHome,
  olympusDataPath,
  olympusDataRoot,
  xdgDataHome,
} from '../src/core/olympus-layout.ts';
import { defaultXBookmarksApiUsageDbPath } from '../src/workers/x-bookmarks/live-control.ts';
import { defaultXBookmarksReconcileStateDbPath } from '../src/workers/x-bookmarks/reconcile-state.ts';
import { lifecycleSourceSpecs } from '../src/data-lifecycle.ts';

const ROOT = join(import.meta.dir, '..');
const home = '/home/layout-test';

describe('olympus layout', () => {
  test('the data root follows XDG_DATA_HOME, else the home the environment names', () => {
    if (process.platform === 'linux') return; // a Linux receipt can select another root; covered by the engine-layout tests
    expect(olympusDataRoot({ HOME: home })).toBe(`${home}/.local/share/openclaw/olympus`);
    expect(olympusDataRoot({ HOME: home, XDG_DATA_HOME: '/data' })).toBe('/data/openclaw/olympus');
    expect(olympusDataPath({ HOME: home }, 'a', 'b.sqlite')).toBe(`${home}/.local/share/openclaw/olympus/a/b.sqlite`);
    expect(layoutHome({ HOME: '  ' })).toBe(process.env.HOME!);
    expect(xdgDataHome({ HOME: home, XDG_DATA_HOME: '  ' })).toBe(`${home}/.local/share`);
  });

  test('a relative XDG_DATA_HOME is refused rather than resolved against the working directory', () => {
    if (process.platform === 'linux') return;
    expect(() => olympusDataRoot({ HOME: home, XDG_DATA_HOME: 'relative/data' })).toThrow(/absolute/);
  });

  test('legacy locations are named, unchanged', () => {
    expect(legacyCaptureDataRoot({ HOME: home })).toBe(`${home}/.local/share/olympus`);
    expect(legacyCaptureDataRoot({ HOME: home, XDG_DATA_HOME: '/data' })).toBe('/data/olympus');
    if (process.platform === 'linux') return;
    // Telegram's stores ignore XDG_DATA_HOME today; moving them is step 4's job.
    expect(legacyTelegramStoreRoot({ HOME: home, XDG_DATA_HOME: '/data' })).toBe(`${home}/.local/share/openclaw/olympus`);
  });

  test('the X recovery command opens the reconcile state the worker writes', () => {
    const env = { HOME: home };
    const workerPath = `${defaultXBookmarksApiUsageDbPath(env)}.reconcile`;
    expect(defaultXBookmarksReconcileStateDbPath(env)).toBe(workerPath);
    const lifecycle = lifecycleSourceSpecs().find((spec) => spec.sourceId === 'x.bookmarks');
    expect(lifecycle?.accountStateSqlite?.({ env }).map((entry) => entry.path)).toContain(workerPath);
  });
});

// Files that may still read XDG_DATA_HOME or spell the data root themselves.
// Each is environment plumbing or install layout, not a data path. The list
// only shrinks: an entry that no longer matches fails too.
const ALLOWED: Record<string, string> = {
  'src/core/olympus-layout.ts': 'the layout module',
  'src/core/linux-engine-layout.ts': 'standalone Linux install layout and its receipt roots',
  'src/core/linux-engine-service.ts': 'hands the install layout\'s XDG roots to the service unit',
  'src/core/native-embedding-drain-service.ts': 'environment names passed through to a child',
  'src/core/native-relay-service.ts': 'environment names passed through to a child',
  'src/core/remote-access.ts': 'forwards the worker\'s XDG_DATA_HOME from worker.env to a CLI lookup',
  'src/core/remote-connections.ts': 'forwards the worker\'s XDG_DATA_HOME from worker.env to a CLI lookup',
  'src/core/managed-tools.ts': 'the managed tools install root, not the data root',
  'src/data-lifecycle.ts': 'builds an environment for an explicit home directory',
  'src/core/pairing-session-paths.ts': 'names every root Olympus owns, for the delete fence',
};
const DATA_ROOT_EXPRESSION = /XDG_DATA_HOME|'openclaw',\s*'olympus'|openclaw\/olympus/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('data root guard', () => {
  test('no module outside the allowlist builds the data root inline', () => {
    const matching = sourceFiles(join(ROOT, 'src'))
      .filter((path) => readFileSync(path, 'utf8').split('\n')
        .some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && DATA_ROOT_EXPRESSION.test(line)))
      .map((path) => relative(ROOT, path))
      .sort();
    const unexpected = matching.filter((path) => !(path in ALLOWED));
    const stale = Object.keys(ALLOWED).filter((path) => !matching.includes(path));
    expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] });
  });
});
