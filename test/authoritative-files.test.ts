/**
 * Delete safety for files other things depend on, and for targets whose path
 * leads somewhere else: every path is canonicalized, a database not at its
 * source's default place must prove it is the source's own, and the shared
 * authoritative files come from one registry that a test keeps complete.
 */
import { existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { AUTHORITATIVE_FILE_RESOLVERS, deleteOlympusData } from '../src/data-lifecycle.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-authoritative-'));
  dirs.push(dir);
  const homeDir = join(dir, 'home');
  const dataHome = join(homeDir, '.local', 'share');
  mkdirSync(homeDir, { recursive: true });
  return { dir, homeDir, dataHome, env: { XDG_DATA_HOME: dataHome } as Record<string, string> };
}

const BY_NAME = new Map(AUTHORITATIVE_FILE_RESOLVERS.map((entry) => [entry.name, entry]));

describe('shared authoritative files are protected whatever variable points at them', () => {
  for (const name of ['defaultPrivacyProfilePath', 'defaultTierRulesPath', 'defaultXBookmarksApiUsageDbPath', 'defaultSourceIngestionExclusionsPath', 'resolveClassificationLedgerPath']) {
    test(`${name}`, () => {
      const l = lab();
      const file = BY_NAME.get(name)!.resolve({ HOME: l.homeDir, ...l.env });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'KEEP=1\n');
      for (const [sourceId, variable] of [
        ['gmail.email', 'OLYMPUS_EMAIL_INDEX_DB_PATH'],
        ['dropbox.files', 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_DB_PATH'],
      ] as const) {
        expect(() => deleteOlympusData({ sourceId, homeDir: l.homeDir, env: { ...l.env, [variable]: file } } as never)).toThrow();
        expect(readFileSync(file, 'utf8')).toBe('KEEP=1\n');
      }
    });
  }
});

describe('a target is canonicalized before it is unlinked', () => {
  test('a relocated store reached through a symlinked parent is refused and what the link points at survives', () => {
    const l = lab();
    const outside = join(l.dir, 'outside');
    mkdirSync(outside, { recursive: true });
    const precious = join(outside, 'moved.sqlite');
    const db = new Database(precious, { create: true });
    db.exec('create table notes (id integer primary key); ');
    db.close();
    const root = join(l.dataHome, 'openclaw', 'olympus');
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, join(root, 'link'));
    expect(() => deleteOlympusData({
      sourceId: 'dropbox.files',
      homeDir: l.homeDir,
      env: { ...l.env, OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: join(root, 'link', 'moved.sqlite') },
    } as never)).toThrow('symbolic link');
    expect(existsSync(precious)).toBe(true);
  });

  test('a database moved by an override, even inside the Olympus data root, must prove it is the source\'s own', () => {
    const l = lab();
    const root = join(l.dataHome, 'openclaw', 'olympus');
    mkdirSync(root, { recursive: true });
    const stranger = join(root, 'someone-elses.sqlite');
    const db = new Database(stranger, { create: true });
    db.exec('create table notes (id integer primary key, body text); insert into notes (body) values (\'keep\');');
    db.close();
    expect(() => deleteOlympusData({
      sourceId: 'dropbox.files',
      homeDir: l.homeDir,
      env: { ...l.env, OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: stranger },
    } as never)).toThrow();
    expect(existsSync(stranger)).toBe(true);
    expect(new Database(stranger, { readonly: true }).query('select body from notes').get()).toEqual({ body: 'keep' });
  });
});

// Every exported default/resolve path function in src, classified. A new one
// fails this test until it is either added to AUTHORITATIVE_FILE_RESOLVERS or
// named here with the reason it is not authoritative shared state.
const OWNED_BY_A_SOURCE = 'owned by one source: its own delete targets';
const NOT_SHARED = 'not shared authoritative state: runtime output, cache or a path another guard owns';
const CLASSIFIED: Record<string, string> = {
  // In the registry (checked below).
  workerSetupEnvPath: 'registry',
  resolveEmbeddingLedgerPath: 'registry',
  resolveClassificationLedgerPath: 'registry',
  defaultSourceSchedulerStateDbPath: 'registry',
  defaultSourceIngestionExclusionsPath: 'registry',
  defaultPrivacyProfilePath: 'registry',
  defaultTierRulesPath: 'registry',
  defaultXBookmarksApiUsageDbPath: 'registry',
  // Named directly in authoritativeStatePaths or its sibling guards.
  defaultHandleRegistryPath: 'authoritativeStatePaths: registry directory',
  defaultOwnerConfigPath: 'authoritativeStatePaths: owner config',
  defaultSovereigntyConfigPath: 'authoritativeStatePaths: sovereignty config',
  defaultEncryptedSecretsPath: 'authoritativeStatePaths: secret store',
  defaultEncryptedSecretsKeyPath: 'authoritativeStatePaths: secret key',
  resolveLinuxSecretPaths: 'authoritativeStatePaths: Linux secret layout',
  defaultFileExtractionJobsDbPath: 'authoritativeStatePaths: shared extraction jobs',
  defaultRemoteConnectionsDbPath: 'authoritativeStatePaths: remote connections',
  resolveRemoteConnectionsDbPath: 'authoritativeStatePaths: remote connections',
  defaultThisComputerStatePath: 'authoritativeStatePaths: beside the registry',
  defaultOlympusConfigDir: 'authoritativeStatePaths: config directory',
  resolvePrivacyProfilePath: 'registry (defaultPrivacyProfilePath)',
  resolveSourceIngestionExclusionsPath: 'registry (defaultSourceIngestionExclusionsPath)',
  resolveTierRulesPath: 'registry (defaultTierRulesPath)',
  resolveTierMigrationPaths: 'registry (tier rules and ledgers)',
  // Per-source stores, spool and state: the source's own delete targets.
  defaultArchiveImportStatePath: OWNED_BY_A_SOURCE,
  defaultDropboxConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultDropboxIngestionPolicyPath: OWNED_BY_A_SOURCE,
  defaultDropboxInternalConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultDropboxPublicConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultFileSourceScopeStatePath: OWNED_BY_A_SOURCE,
  defaultGmailConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultGmailPublicConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultGmailRequestBudgetStatePath: OWNED_BY_A_SOURCE,
  defaultGmailSecureConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultGoogleDriveConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultGoogleDrivePublicConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultGoogleDriveRequestBudgetStatePath: OWNED_BY_A_SOURCE,
  defaultGoogleDriveSecureConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultInternalTelegramConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultLocalFilesConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultLocalFilesInternalConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultLocalFilesPublicConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultMailSourceScopeStatePath: OWNED_BY_A_SOURCE,
  defaultMessagingCaptureGrantPath: OWNED_BY_A_SOURCE,
  defaultProtectedTelegramConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultReadwiseConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultReadwiseRequestBudgetStatePath: OWNED_BY_A_SOURCE,
  defaultReadwiseSecureConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultTelegramCaptureSpoolDir: OWNED_BY_A_SOURCE,
  defaultWhatsAppConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultWhatsAppInternalConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultWhatsAppMediaDir: OWNED_BY_A_SOURCE,
  defaultWhatsAppSpoolDir: OWNED_BY_A_SOURCE,
  defaultWhatsAppStateDir: OWNED_BY_A_SOURCE,
  defaultXBookmarksConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  defaultXBookmarksContentRecoveryReceiptPath: OWNED_BY_A_SOURCE,
  defaultXBookmarksReconcileStateDbPath: OWNED_BY_A_SOURCE,
  defaultXBookmarksSecureConnectorStoreDbPath: OWNED_BY_A_SOURCE,
  // Runtime output and caches.
  defaultCredentialBrokerStatePath: NOT_SHARED,
  defaultCredentialHealthReportPath: NOT_SHARED,
  defaultDetachedOAuthLogDir: NOT_SHARED,
  defaultDetachedOAuthStateDir: NOT_SHARED,
  defaultSourceDashboardHistoryDbPath: NOT_SHARED,
  defaultSourceWatchDbPath: NOT_SHARED,
  defaultVeniceModelCatalogCachePath: NOT_SHARED,
  defaultZkapiStatePath: NOT_SHARED,
  resolveBunRuntimePath: NOT_SHARED,
  resolveEmbeddingDrainReportPath: NOT_SHARED,
  resolveEmbeddingOverridePath: NOT_SHARED,
  resolveGuardReportPath: NOT_SHARED,
  resolveSourceAnswerLatencyLogPath: NOT_SHARED,
};

function exportedResolverNames(): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) {
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(/export (?:async )?function ((?:default|resolve)[A-Za-z0-9]*(?:Path|Paths|Dir|Root))\b/g)) names.add(match[1]!);
      }
    }
  };
  walk(join(import.meta.dir, '..', 'src'));
  return [...names].sort();
}

describe('the authoritative-file registry is complete', () => {
  test('every exported path resolver is classified, and the registry matches its classification', () => {
    const found = exportedResolverNames();
    const unclassified = found.filter((name) => !(name in CLASSIFIED) && !BY_NAME.has(name));
    expect(unclassified, `classify these in test/authoritative-files.test.ts (or add them to AUTHORITATIVE_FILE_RESOLVERS): ${unclassified.join(', ')}`).toEqual([]);
    const stale = Object.keys(CLASSIFIED).filter((name) => !found.includes(name) && !BY_NAME.has(name));
    expect(stale, 'classified names that no longer exist').toEqual([]);
    for (const [name, why] of Object.entries(CLASSIFIED)) {
      if (why === 'registry') expect(BY_NAME.has(name), `${name} is classified as registered`).toBe(true);
    }
    for (const name of BY_NAME.keys()) expect(CLASSIFIED[name] ?? 'registry').toBe('registry');
  });

  test('every registered resolver names a real file under the throwaway home', () => {
    const l = lab();
    for (const entry of AUTHORITATIVE_FILE_RESOLVERS) {
      const path = entry.resolve({ HOME: l.homeDir, ...l.env });
      expect(relative(l.dir, path).startsWith('..') ? path.startsWith(process.env.OLYMPUS_TEST_ISOLATED_HOME!) || path.startsWith(realpathSync(process.env.OLYMPUS_TEST_ISOLATED_HOME!)) : true, `${entry.name} -> ${path}`).toBe(true);
    }
  });
});
