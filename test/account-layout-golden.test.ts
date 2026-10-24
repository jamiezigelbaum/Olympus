// A `legacy` account resolves every path exactly as the connectors' own
// resolvers did before account folders (docs/design/source-storage.md,
// delivery step 4a). The expected values are a fixture generated once from the
// functions as they stood on main (test/fixtures/legacy-resolution-golden.json),
// never computed with the code under test.

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
import {
  DROPBOX_CONNECTOR_STORE_DB_PATH_ENV,
  DROPBOX_INTERNAL_CONNECTOR_STORE_DB_PATH_ENV,
  DROPBOX_PUBLIC_CONNECTOR_STORE_DB_PATH_ENV,
  defaultDropboxConnectorStoreDbPath,
  defaultDropboxInternalConnectorStoreDbPath,
  defaultDropboxPublicConnectorStoreDbPath,
  dropboxTierConnectorStoreDbPaths,
} from '../src/workers/dropbox-files/connector-store.ts';
import {
  defaultGmailConnectorStoreDbPath,
  defaultGmailPublicConnectorStoreDbPath,
  defaultGmailSecureConnectorStoreDbPath,
} from '../src/workers/google-connectors/gmail.ts';
import {
  defaultGoogleDriveConnectorStoreDbPath,
  defaultGoogleDrivePublicConnectorStoreDbPath,
  defaultGoogleDriveSecureConnectorStoreDbPath,
} from '../src/workers/google-connectors/drive.ts';
import {
  LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV,
  LOCAL_FILES_INTERNAL_CONNECTOR_STORE_DB_PATH_ENV,
  LOCAL_FILES_PUBLIC_CONNECTOR_STORE_DB_PATH_ENV,
  defaultLocalFilesConnectorStoreDbPath,
  defaultLocalFilesInternalConnectorStoreDbPath,
  defaultLocalFilesPublicConnectorStoreDbPath,
  localFilesTierConnectorStoreDbPaths,
  localFilesWatchDir,
} from '../src/workers/local-files/store.ts';
import { defaultReadwiseConnectorStoreDbPath } from '../src/workers/readwise/connector.ts';
import { defaultReadwiseSecureConnectorStoreDbPath } from '../src/workers/readwise/tier-set.ts';
import { defaultXBookmarksConnectorStoreDbPath } from '../src/workers/x-bookmarks/connector.ts';
import { defaultXBookmarksApiUsageDbPath } from '../src/workers/x-bookmarks/live-control.ts';
import { defaultXBookmarksReconcileStateDbPath } from '../src/workers/x-bookmarks/reconcile-state.ts';
import { defaultXBookmarksSecureConnectorStoreDbPath } from '../src/workers/x-bookmarks/tier-set.ts';
import golden from './fixtures/legacy-resolution-golden.json';

type Env = Record<string, string | undefined>;
type Resolvers = Record<string, (env: Env) => unknown>;

const TIERS = ['secure_local', 'internal', 'public_safe'] as const;

const resolvers: Resolvers = {
  'gmail.internal': (env) => defaultGmailConnectorStoreDbPath(env),
  'gmail.secure_local': (env) => defaultGmailSecureConnectorStoreDbPath(env),
  'gmail.public_safe': (env) => defaultGmailPublicConnectorStoreDbPath(env),
  'google_drive.internal': (env) => defaultGoogleDriveConnectorStoreDbPath(env),
  'google_drive.secure_local': (env) => defaultGoogleDriveSecureConnectorStoreDbPath(env),
  'google_drive.public_safe': (env) => defaultGoogleDrivePublicConnectorStoreDbPath(env),
  'dropbox.secure_local': (env) => defaultDropboxConnectorStoreDbPath(env),
  'dropbox.internal': (env) => defaultDropboxInternalConnectorStoreDbPath(env),
  'dropbox.public_safe': (env) => defaultDropboxPublicConnectorStoreDbPath(env),
  'dropbox.all': (env) => dropboxTierConnectorStoreDbPaths(env),
  'local_files.secure_local': (env) => defaultLocalFilesConnectorStoreDbPath(env),
  'local_files.internal': (env) => defaultLocalFilesInternalConnectorStoreDbPath(env),
  'local_files.public_safe': (env) => defaultLocalFilesPublicConnectorStoreDbPath(env),
  'local_files.all': (env) => localFilesTierConnectorStoreDbPaths(env),
  'local_files.watch': (env) => localFilesWatchDir(env),
  'readwise.internal': (env) => defaultReadwiseConnectorStoreDbPath(env),
  'readwise.secure_local': (env) => defaultReadwiseSecureConnectorStoreDbPath(env),
  'x.internal': (env) => defaultXBookmarksConnectorStoreDbPath(env),
  'x.secure_local': (env) => defaultXBookmarksSecureConnectorStoreDbPath(env),
  'x.usage': (env) => defaultXBookmarksApiUsageDbPath(env),
  'x.reconcile': (env) => defaultXBookmarksReconcileStateDbPath(env),
  'x.reconcile+usage': (env) => defaultXBookmarksReconcileStateDbPath(env, defaultXBookmarksApiUsageDbPath(env)),
  'x.reconcile+memory': (env) => defaultXBookmarksReconcileStateDbPath(env, ':memory:'),
  'x.reconcile+custom': (env) => defaultXBookmarksReconcileStateDbPath(env, '/custom/usage.sqlite'),
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
function caseEnv(name: string): { env: Env; platform?: string } {
  const homeOnly = { HOME: home };
  if (name === 'default') return { env: homeOnly };
  if (name === 'xdg') return { env: { ...homeOnly, XDG_DATA_HOME: xdg } };
  if (name === 'xdg-padded') return { env: { ...homeOnly, XDG_DATA_HOME: `  ${xdg}  ` } };
  if (name === 'linux-receipt') return { platform: 'linux', env: { ...homeOnly, OLYMPUS_STANDALONE: '1' } };
  if (name === 'linux-receipt-xdg') return { platform: 'linux', env: { ...homeOnly, XDG_DATA_HOME: xdg, OLYMPUS_STANDALONE: '1' } };
  const single = /^override:(.*)$/.exec(name);
  if (single) return { env: { ...homeOnly, [single[1]!]: `  /golden/override/${single[1]!.toLowerCase()}.sqlite  ` } };
  const blank = /^override-blank:(.*)$/.exec(name);
  if (blank) return { env: { ...homeOnly, ...Object.fromEntries(overrideNames(blank[1]!).map((n) => [n, '   '])) } };
  const all = /^override-all:(.*)$/.exec(name);
  if (all) {
    return {
      env: {
        ...homeOnly,
        XDG_DATA_HOME: xdg,
        ...Object.fromEntries(overrideNames(all[1]!).map((n) => [n, `/golden/override/${n.toLowerCase()}.sqlite`])),
      },
    };
  }
  throw new Error(`unknown golden case ${name}`);
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

function withPlatform<T>(platform: string | undefined, run: () => T): T {
  if (!platform) return run();
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
    expect(names).toEqual(expect.arrayContaining(['default', 'xdg', 'xdg-padded', 'linux-receipt', 'linux-receipt-xdg']));
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
    const results = (golden.cases as Record<string, Record<string, unknown>>)[name]!;
    withPlatform(platform, () => {
      writeLegacyRegistry(env);
      for (const [key, expected] of Object.entries(results)) {
        expect(resolvers[key]!(env), `${name}: ${key}`).toEqual(realized(expected));
      }
    });
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
      for (const [key, expected] of Object.entries(results)) {
        expect(resolvers[key]!(env), `${name}: ${key}`).toEqual(realized(expected));
      }
    });
  });

  test('an override pins an account that has no entry: the override is honored, nothing moves', () => {
    for (const [name] of cases.filter(([n]) => n.startsWith('override:') || n.startsWith('override-all:'))) {
      const { env } = caseEnv(name);
      const results = (golden.cases as Record<string, Record<string, unknown>>)[name]!;
      for (const [key, expected] of Object.entries(results)) {
        expect(resolvers[key]!(env), `${name}: ${key}`).toEqual(realized(expected));
      }
    }
  });

  test('the connectors export the override names the layout honors', () => {
    expect(DROPBOX_CONNECTOR_STORE_DB_PATH_ENV).toBe(OVERRIDE_GROUPS.dropbox![0]!);
    expect(DROPBOX_INTERNAL_CONNECTOR_STORE_DB_PATH_ENV).toBe(OVERRIDE_GROUPS.dropbox![1]!);
    expect(DROPBOX_PUBLIC_CONNECTOR_STORE_DB_PATH_ENV).toBe(OVERRIDE_GROUPS.dropbox![2]!);
    expect(LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV).toBe(OVERRIDE_GROUPS.localfiles![0]!);
    expect(LOCAL_FILES_INTERNAL_CONNECTOR_STORE_DB_PATH_ENV).toBe(OVERRIDE_GROUPS.localfiles![1]!);
    expect(LOCAL_FILES_PUBLIC_CONNECTOR_STORE_DB_PATH_ENV).toBe(OVERRIDE_GROUPS.localfiles![2]!);
  });
});
