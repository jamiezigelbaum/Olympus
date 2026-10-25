// The layout module is the one place that computes the data root
// (docs/design/source-storage.md, step 1). These pin what it returns and keep
// a new module from rebuilding the expression inline, which is how the store
// paths drifted apart in the first place.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import {
  legacyCaptureDataRoot,
  legacyTelegramGatewayStateDir,
  legacyTelegramStoreRoot,
  legacyWhatsAppServiceStateDir,
  layoutHome,
  olympusDataPath,
  olympusDataRoot,
  xdgDataHome,
} from '../src/core/olympus-layout.ts';
import { defaultXBookmarksApiUsageDbPath } from '../src/workers/x-bookmarks/live-control.ts';
import { defaultXBookmarksReconcileStateDbPath } from '../src/workers/x-bookmarks/reconcile-state.ts';
import { lifecycleAccountFiles } from '../src/data-lifecycle.ts';
import { olympusDataDir } from '../src/core/remote-access.ts';
import { defaultRemoteConnectionsDbPath } from '../src/core/remote-connections.ts';

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

  test('a relative XDG_DATA_HOME resolves as it always did; remote access still refuses it', () => {
    if (process.platform === 'linux') return;
    expect(olympusDataPath({ HOME: home, XDG_DATA_HOME: 'relative/data' }, 'gmail-connector-store.sqlite'))
      .toBe('relative/data/openclaw/olympus/gmail-connector-store.sqlite');
    expect(() => olympusDataDir({ HOME: home, XDG_DATA_HOME: 'relative/data' })).toThrow(/absolute/);
    expect(() => defaultRemoteConnectionsDbPath({ HOME: home, XDG_DATA_HOME: 'relative/data' })).toThrow(/absolute/);
  });

  test('legacy locations are named, unchanged', () => {
    expect(legacyCaptureDataRoot({ HOME: home })).toBe(`${home}/.local/share/olympus`);
    expect(legacyCaptureDataRoot({ HOME: home, XDG_DATA_HOME: '/data' })).toBe('/data/olympus');
    if (process.platform === 'linux') return;
    // Telegram's stores ignore XDG_DATA_HOME today; moving them is step 4's job.
    expect(legacyTelegramStoreRoot({ HOME: home, XDG_DATA_HOME: '/data' })).toBe(`${home}/.local/share/openclaw/olympus`);
    // The WhatsApp capture service ignores it too, unlike pairing and the readers.
    expect(legacyWhatsAppServiceStateDir({ HOME: home, XDG_DATA_HOME: '/data' })).toBe(`${home}/.local/share/olympus/whatsapp-live`);
  });

  test('the Telegram readiness probe reads gateway state where the reader writes it', () => {
    // scripts/telegram-telethon-reader.py: XDG_STATE_HOME, else <home>/.local/state.
    expect(legacyTelegramGatewayStateDir({ HOME: home })).toBe(`${home}/.local/state/olympus/telegram-capture-gateway`);
    expect(legacyTelegramGatewayStateDir({ HOME: home, XDG_STATE_HOME: '/state' })).toBe('/state/olympus/telegram-capture-gateway');
    expect(legacyTelegramGatewayStateDir({ HOME: home, OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: ' /gw ' })).toBe('/gw');
  });

  test('the X recovery command opens the reconcile state the worker writes', () => {
    // A new account keeps it in its own folder; the usage ledger stays shared in the data root.
    const env = { HOME: home };
    const folderPath = `${olympusDataRoot(env)}/sources/x.bookmarks/1/raw/x-reconcile.sqlite`;
    expect(defaultXBookmarksApiUsageDbPath(env)).toBe(`${olympusDataRoot(env)}/x-bookmarks-api-usage.sqlite`);
    expect(defaultXBookmarksReconcileStateDbPath(env)).toBe(folderPath);
    expect(defaultXBookmarksReconcileStateDbPath(env, defaultXBookmarksApiUsageDbPath(env))).toBe(folderPath);
    // A folder account's reconcile state is in its folder, which a Delete takes whole.
    expect(folderPath.startsWith(`${lifecycleAccountFiles('x.bookmarks', { env }).folder}/`)).toBe(true);
    // An account an override pins keeps the old rule: beside the usage ledger.
    const pinned = { HOME: home, OLYMPUS_SOURCE_INDEX_X_API_USAGE_DB_PATH: '/pinned/usage.sqlite' };
    const workerPath = `${defaultXBookmarksApiUsageDbPath(pinned)}.reconcile`;
    expect(workerPath).toBe('/pinned/usage.sqlite.reconcile');
    expect(defaultXBookmarksReconcileStateDbPath(pinned)).toBe(workerPath);
    expect(lifecycleAccountFiles('x.bookmarks', { env: pinned }).rawDatabases.map((entry) => entry.path)).toContain(workerPath);
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
  'src/core/lifecycle.ts': 'the installed plugin versions folder (~/.local/share/olympus/versions), install layout',
  'src/core/lifecycle-artifact.ts': 'the installed plugin versions folder (~/.local/share/olympus/versions), install layout',
  'src/data-lifecycle.ts': 'builds an environment for an explicit home directory',
  'src/core/pairing-session-paths.ts': 'names every root Olympus owns, for the delete fence',
};
// The data root and the legacy capture root, in any quote style, with the
// segments split across lines or written as one path.
const DATA_ROOT_EXPRESSION = /XDG_DATA_HOME|(['"`])(?:openclaw|share)\1\s*,\s*(['"`])olympus\2|(?:openclaw|share)\/olympus\b/;

// Parsed and printed without comments, so no comment, inline or whole-line,
// can split an expression or hide one.
const printer = ts.createPrinter({ removeComments: true });
function buildsDataRoot(source: string): boolean {
  const file = ts.createSourceFile('guard.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return DATA_ROOT_EXPRESSION.test(printer.printFile(file));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('data root guard', () => {
  test('the guard sees every spelling of an inline root', () => {
    for (const spelling of [
      "join(home, '.local', 'share', 'openclaw', 'olympus')",
      'join(home, ".local", "share", "openclaw", "olympus")',
      "join(\n  dataHome,\n  'openclaw',\n  'olympus',\n)",
      "join(home, '.local/share/openclaw/olympus')",
      "join(home, '.local', 'share', 'olympus', 'whatsapp-live')",
      "const DEFAULT = '.local/share/olympus/whatsapp-live';",
      'env.XDG_DATA_HOME?.trim()',
      "join(home, '.local', 'share', 'openclaw', // namespace\n  'olympus')",
      "join(home, '.local', 'share', /* legacy */ 'olympus')",
    ]) expect(buildsDataRoot(spelling), spelling).toBe(true);
    expect(buildsDataRoot("// join(home, 'openclaw', 'olympus')")).toBe(false);
    expect(buildsDataRoot("join(home, '.config', 'olympus')")).toBe(false);
  });

  test('no module outside the allowlist builds the data root inline', () => {
    const matching = sourceFiles(join(ROOT, 'src'))
      .filter((path) => buildsDataRoot(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path))
      .sort();
    const unexpected = matching.filter((path) => !(path in ALLOWED));
    const stale = Object.keys(ALLOWED).filter((path) => !matching.includes(path));
    expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] });
  });
});
