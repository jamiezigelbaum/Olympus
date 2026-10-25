// A `legacy` account resolves every path exactly as the connectors' own
// resolvers did before account folders (docs/design/source-storage.md,
// delivery step 4a). The expected values are a fixture generated once from the
// functions as they stood on main (test/fixtures/legacy-resolution-golden.json),
// never computed with the code under test. Since step 6 no env variable
// relocates a store (owner decision 3): a case that sets one resolves as the
// same environment without it, which the fixture records too.

import { resolvedStorePath, resolvedRawPath } from '../src/core/source-placement.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { archiveImportFamilies } from '../src/core/archive-formats.ts';
import { olympusDataRoot } from '../src/core/olympus-layout.ts';
import { FOLDER_LAYOUT_SOURCES } from '../src/core/olympus-layout.ts';
import { sourceRegistryPath } from '../src/core/source-registry.ts';
import { archiveImportRequestsPath } from '../src/workers/archive-import/requests.ts';
import { defaultArchiveImportStatePath } from '../src/workers/archive-import/state.ts';
import { archiveConnectorStoreDbPath, archiveConnectorStoreDbPaths } from '../src/workers/archive-import/store.ts';
import { dropboxTierConnectorStoreDbPaths } from '../src/workers/dropbox-files/connector-store.ts';
import {
  localFilesTierConnectorStoreDbPaths,
  localFilesWatchDir,
} from '../src/workers/local-files/store.ts';
import { defaultXBookmarksApiUsageDbPath } from '../src/workers/x-bookmarks/live-control.ts';
import golden from './fixtures/legacy-resolution-golden.json';

type Env = Record<string, string | undefined>;
type Resolvers = Record<string, (env: Env) => unknown>;

const TIERS = ['secure_local', 'internal', 'public_safe'] as const;

const resolvers: Resolvers = {
  'gmail.internal': (env) => resolvedStorePath('gmail.email', 'internal', env),
  'gmail.secure_local': (env) => resolvedStorePath('gmail.email', 'secure_local', env),
  'gmail.public_safe': (env) => resolvedStorePath('gmail.email', 'public_safe', env),
  'google_drive.internal': (env) => resolvedStorePath('google_drive.docs', 'internal', env),
  'google_drive.secure_local': (env) => resolvedStorePath('google_drive.docs', 'secure_local', env),
  'google_drive.public_safe': (env) => resolvedStorePath('google_drive.docs', 'public_safe', env),
  'dropbox.secure_local': (env) => resolvedStorePath('dropbox.files', 'secure_local', env),
  'dropbox.internal': (env) => resolvedStorePath('dropbox.files', 'internal', env),
  'dropbox.public_safe': (env) => resolvedStorePath('dropbox.files', 'public_safe', env),
  'dropbox.all': (env) => dropboxTierConnectorStoreDbPaths(env),
  'local_files.secure_local': (env) => resolvedStorePath('local.files', 'secure_local', env),
  'local_files.internal': (env) => resolvedStorePath('local.files', 'internal', env),
  'local_files.public_safe': (env) => resolvedStorePath('local.files', 'public_safe', env),
  'local_files.all': (env) => localFilesTierConnectorStoreDbPaths(env),
  'local_files.watch': (env) => localFilesWatchDir(env),
  'readwise.internal': (env) => resolvedStorePath('readwise.library', 'internal', env),
  'readwise.secure_local': (env) => resolvedStorePath('readwise.library', 'secure_local', env),
  'x.internal': (env) => resolvedStorePath('x.bookmarks', 'internal', env),
  'x.secure_local': (env) => resolvedStorePath('x.bookmarks', 'secure_local', env),
  'x.usage': (env) => defaultXBookmarksApiUsageDbPath(env),
  'x.reconcile': (env) => resolvedRawPath('x.bookmarks', 'x-reconcile.sqlite', env),
  'x.reconcile+usage': (env) => resolvedRawPath('x.bookmarks', 'x-reconcile.sqlite', env, { usageDbPath: defaultXBookmarksApiUsageDbPath(env) }),
  'x.reconcile+memory': (env) => resolvedRawPath('x.bookmarks', 'x-reconcile.sqlite', env, { usageDbPath: ':memory:' }),
  'x.reconcile+custom': (env) => resolvedRawPath('x.bookmarks', 'x-reconcile.sqlite', env, { usageDbPath: '/custom/usage.sqlite' }),
  'archive.all': (env) => archiveConnectorStoreDbPaths(archiveImportFamilies(), env),
  'archive.state': (env) => defaultArchiveImportStatePath(env),
  'archive.requests': (env) => archiveImportRequestsPath(defaultArchiveImportStatePath(env)),
};
for (const family of archiveImportFamilies()) {
  for (const domain of TIERS) {
    resolvers[`archive.${family}.${domain}`] = (env) => archiveConnectorStoreDbPath(domain, family, env);
  }
}

let base: string;
let home: string;
let xdg: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'olympus-layout-golden-'));
  home = join(base, 'home');
  xdg = join(base, 'xdg');
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The fixture's `{HOME}` and `{XDG}` made real, in a path, a list or an environment value. */
function realized<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replaceAll('{HOME}', home).replaceAll('{XDG}', xdg));
}

/** The registry a pre-folder install has: every source adopted as `legacy`. */
function writeLegacyRegistry(env: Env): void {
  const path = sourceRegistryPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schema: 1,
    accounts: FOLDER_LAYOUT_SOURCES.map((source_id) => ({
      source_id,
      slot: '1',
      state: 'active',
      layout: 'legacy',
      corpus_ids: [],
      created_at: '2026-10-01T00:00:00.000Z',
    })),
  })}\n`);
}

// What each case sets, besides the home: the same environments the fixture was
// generated with. An override case sets one variable, padded, to prove the trim.
// Every case runs under the platform it was generated under: darwin unless it says Linux.
// The data folder depends on the platform (a standalone Linux engine's receipt, and Linux
// refusing a padded XDG_DATA_HOME), so a case without a pinned platform would change with the machine.
function caseEnv(name: string): { env: Env; platform: string } {
  const homeOnly = { HOME: home };
  if (name === 'default') return { platform: 'darwin', env: homeOnly };
  if (name === 'xdg') return { platform: 'darwin', env: { ...homeOnly, XDG_DATA_HOME: xdg } };
  if (name === 'xdg-padded') return { platform: 'darwin', env: { ...homeOnly, XDG_DATA_HOME: `  ${xdg}  ` } };
  if (name === 'linux-receipt') return { platform: 'linux', env: { ...homeOnly, OLYMPUS_STANDALONE: '1' } };
  if (name === 'linux-receipt-xdg') return { platform: 'linux', env: { ...homeOnly, XDG_DATA_HOME: xdg, OLYMPUS_STANDALONE: '1' } };
  // An OpenClaw-hosted Linux process: no standalone marker, so the hosted namespace.
  if (name === 'linux-hosted') return { platform: 'linux', env: homeOnly };
  if (name === 'linux-hosted-xdg') return { platform: 'linux', env: { ...homeOnly, XDG_DATA_HOME: xdg } };
  if (name === 'linux-hosted-xdg-padded') return { platform: 'linux', env: { ...homeOnly, XDG_DATA_HOME: `  ${xdg}  ` } };
  const single = /^override:(.*)$/.exec(name);
  if (single) return { platform: 'darwin', env: { ...homeOnly, [single[1]!]: `  /golden/override/${single[1]!.toLowerCase()}.sqlite  ` } };
  const blank = /^override-blank:(.*)$/.exec(name);
  if (blank) return { platform: 'darwin', env: { ...homeOnly, ...Object.fromEntries(overrideNames(blank[1]!).map((n) => [n, '   '])) } };
  const all = /^override-all:(.*)$/.exec(name);
  if (all) {
    return {
      platform: 'darwin',
      env: {
        ...homeOnly,
        XDG_DATA_HOME: xdg,
        ...Object.fromEntries(overrideNames(all[1]!).map((n) => [n, `/golden/override/${n.toLowerCase()}.sqlite`])),
      },
    };
  }
  throw new Error(`unknown golden case ${name}`);
}

/** What the fixture records for a resolver that throws on main. */
const throwsOf = (expected: unknown): string | undefined =>
  expected && typeof expected === 'object' && '$throws' in expected ? String((expected as { $throws: unknown }).$throws) : undefined;

/** A resolver gives the fixture's answer, or throws the fixture's error where main threw. */
function expectResolves(name: string, key: string, env: Env, expected: unknown): void {
  const message = throwsOf(expected);
  if (message !== undefined) expect(() => resolvers[key]!(env), `${name}: ${key}`).toThrow(message);
  else expect(resolvers[key]!(env), `${name}: ${key}`).toEqual(realized(expected));
}

const OVERRIDE_GROUPS: Record<string, string[]> = {
  gmail: [
    'OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_GMAIL_SECURE_CONNECTOR_STORE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_GMAIL_PUBLIC_CONNECTOR_STORE_DB_PATH',
  ],
  drive: [
    'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CONNECTOR_STORE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_SECURE_CONNECTOR_STORE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_PUBLIC_CONNECTOR_STORE_DB_PATH',
  ],
  dropbox: [
    'OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_DROPBOX_INTERNAL_CONNECTOR_STORE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_DROPBOX_PUBLIC_CONNECTOR_STORE_DB_PATH',
  ],
  localfiles: [
    'OLYMPUS_SOURCE_INDEX_LOCAL_FILES_CONNECTOR_STORE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_LOCAL_FILES_INTERNAL_CONNECTOR_STORE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_LOCAL_FILES_PUBLIC_CONNECTOR_STORE_DB_PATH',
  ],
  readwise: [
    'OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_READWISE_SECURE_CONNECTOR_STORE_DB_PATH',
  ],
  x: [
    'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_SECURE_CONNECTOR_STORE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_X_API_USAGE_DB_PATH',
    'OLYMPUS_SOURCE_INDEX_X_RECONCILE_STATE_DB_PATH',
  ],
  archive: ['OLYMPUS_ARCHIVE_IMPORTS_STATE_PATH'],
};
const overrideNames = (group: string): string[] => OVERRIDE_GROUPS[group] ?? [];

/**
 * The fixture case an environment resolves as since step 6: an override case as
 * the same environment without its overrides (`override-all` also sets
 * XDG_DATA_HOME), every other case as itself.
 */
function resolvesAs(name: string): string {
  if (name.startsWith('override-all:')) return 'xdg';
  if (name.startsWith('override:') || name.startsWith('override-blank:')) return 'default';
  return name;
}

function withPlatform<T>(platform: string, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('a legacy account resolves exactly what main resolved', () => {
  const cases = Object.entries(golden.cases as Record<string, Record<string, unknown>>);

  test('the fixture covers the default, XDG, Linux receipt and every override of every 4a source', () => {
    const names = cases.map(([name]) => name);
    expect(names).toEqual(expect.arrayContaining([
      'default', 'xdg', 'xdg-padded', 'linux-receipt', 'linux-receipt-xdg', 'linux-hosted', 'linux-hosted-xdg', 'linux-hosted-xdg-padded',
    ]));
    const everyOverride = Object.values(OVERRIDE_GROUPS).flat();
    for (const override of everyOverride) expect(names).toContain(`override:${override}`);
    for (const group of Object.keys(OVERRIDE_GROUPS)) {
      expect(names).toContain(`override-blank:${group}`);
      expect(names).toContain(`override-all:${group}`);
    }
    // Every resolver the fixture names is exercised below.
    const keys = new Set(cases.flatMap(([, results]) => Object.keys(results)));
    expect([...keys].filter((key) => !(key in resolvers))).toEqual([]);
    expect(Object.keys(resolvers).filter((key) => !keys.has(key))).toEqual([]);
  });

  test.each(cases.map(([name]) => name))('with an entry for it: %s', (name) => {
    const { env, platform } = caseEnv(name);
    const results = (golden.cases as Record<string, Record<string, unknown>>)[resolvesAs(name)]!;
    withPlatform(platform, () => {
      // Where main cannot work out the data folder at all, no registry can be written either.
      if (!Object.values(results).some((expected) => throwsOf(expected) !== undefined)) writeLegacyRegistry(env);
      for (const [key, expected] of Object.entries(results)) expectResolves(name, key, env, expected);
    });
  });

  test('Linux refuses a padded XDG_DATA_HOME as main did, on every resolver that needs the data folder', () => {
    const results = (golden.cases as Record<string, Record<string, unknown>>)['linux-hosted-xdg-padded']!;
    const thrown = Object.entries(results).filter(([, expected]) => throwsOf(expected) !== undefined);
    expect(thrown.length).toBeGreaterThan(30);
    // The reconcile state beside an in-memory or caller-supplied usage ledger never consulted the data folder.
    expect(Object.keys(results).filter((key) => !thrown.some(([name]) => name === key)).sort()).toEqual(['x.reconcile+custom', 'x.reconcile+memory']);
  });

  test.each(['default', 'xdg', 'linux-receipt'])('with legacy files and no entry: %s', (name) => {
    const { env, platform } = caseEnv(name);
    const results = (golden.cases as Record<string, Record<string, unknown>>)[name]!;
    withPlatform(platform, () => {
      // One legacy file of each source is enough to place it legacy.
      const root = olympusDataRoot(env);
      mkdirSync(root, { recursive: true });
      for (const file of [
        'gmail-secure-connector-store.sqlite',
        'google-drive-connector-store.sqlite',
        'dropbox-files-connector-store.tier-ledger.sqlite-wal',
        'local-files-public-connector-store.sqlite',
        'readwise-secure-connector-store.tier-sniffer.sqlite',
        'x-bookmarks-connector-store.sqlite-shm',
        'archive-imports.json',
      ]) writeFileSync(join(root, file), '');
      for (const [key, expected] of Object.entries(results)) expectResolves(name, key, env, expected);
    });
  });

  test('a dropped override pins nothing: an account with no entry is placed as without it', () => {
    for (const [name] of cases.filter(([n]) => n.startsWith('override:') || n.startsWith('override-all:'))) {
      const { env, platform } = caseEnv(name);
      const without = Object.fromEntries(Object.entries(env).filter(([key]) => !Object.values(OVERRIDE_GROUPS).flat().includes(key)));
      withPlatform(platform, () => {
        for (const key of Object.keys(resolvers)) {
          if (throwsOf((golden.cases as Record<string, Record<string, unknown>>)[name]![key]) !== undefined) continue;
          expect(resolvers[key]!(env), `${name}: ${key}`).toEqual(resolvers[key]!(without));
        }
      });
    }
  });
});
