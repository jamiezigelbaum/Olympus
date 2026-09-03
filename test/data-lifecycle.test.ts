import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  deleteOlympusData,
  deleteOlympusDataWithCustody,
  exportOlympusData,
  knownOlympusDataRoots,
  lifecycleSourceSpecs,
  runDataMigrations,
  validateDeleteAllConfirmations,
} from '../src/data-lifecycle.ts';
import { installWorkerService, workerServicePaths } from '../src/core/worker-service.ts';
import { V0_4_PUBLIC_SOURCE_CAPABILITIES } from '../src/core/public-source-capabilities.ts';
import { currentStoreMigrations, runSqliteMigrations } from '../src/core/sqlite-migrations.ts';
import { defaultSourceCorpusRegistryConfig } from '../src/core/source-corpus-registry.ts';

describe('Olympus data lifecycle', () => {
  test('CLI custody requires Disconnect before a public source delete but keeps dry-run available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-delete-custody-'));
    const homeDir = join(dir, 'home');
    try {
      const source = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'dropbox.files')!;
      const dbPath = source.connectorStorePaths!({ homeDir })[0]!;
      mkdirSync(dirname(dbPath), { recursive: true });
      writeFileSync(dbPath, 'dropbox');
      const connectedRegistry = {
        version: 1 as const,
        handles: [{
          handle: 'dropbox.personal',
          provider: 'dropbox' as const,
          accountRole: 'personal',
          trustDomain: 'secure_local' as const,
          allowedCapabilities: ['dropbox.files.sync'],
          scopes: ['files.content.read'],
          connectedAt: '2026-08-30T00:00:00.000Z',
        }],
      };

      const preview = deleteOlympusDataWithCustody({
        sourceId: 'dropbox.files',
        homeDir,
        dryRun: true,
        connectedRegistry,
      });
      expect(preview.custody).toMatchObject({
        requirement: 'source_disconnected',
        ready: false,
        observed: 'connected',
      });
      expect(existsSync(dbPath)).toBe(true);
      expect(() => deleteOlympusDataWithCustody({
        sourceId: 'dropbox.files',
        homeDir,
        connectedRegistry,
      })).toThrow('Disconnect dropbox.files');
      expect(existsSync(dbPath)).toBe(true);

      const deleted = deleteOlympusDataWithCustody({
        sourceId: 'dropbox.files',
        homeDir,
        connectedRegistry: { version: 1, handles: [] },
      });
      expect(deleted.custody).toEqual({
        requirement: 'source_disconnected',
        ready: true,
        observed: 'disconnected',
      });
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI custody requires an inactive supervised worker before delete-all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-delete-all-custody-'));
    const homeDir = join(dir, 'home');
    try {
      const ownedRoot = join(homeDir, '.olympus');
      mkdirSync(ownedRoot, { recursive: true });
      writeFileSync(join(ownedRoot, 'owned-file'), 'owned');
      expect(() => deleteOlympusDataWithCustody({
        all: true,
        homeDir,
        workerState: 'active',
      })).toThrow('Stop or uninstall the Olympus worker');
      expect(existsSync(ownedRoot)).toBe(true);

      const deleted = deleteOlympusDataWithCustody({
        all: true,
        homeDir,
        workerState: 'inactive',
      });
      expect(deleted.custody).toMatchObject({
        requirement: 'worker_inactive',
        ready: true,
        observed: 'inactive',
      });
      expect(existsSync(ownedRoot)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A source with no public capability has no Disconnect to gate on, so its
  // per-source delete falls through to the worker-inactive requirement. The
  // fall-through is only satisfiable when the caller reports the state it
  // observed: an unreported state reads `unknown` and refuses forever, which
  // is exactly what the CLI's per-source branch used to send.
  test('CLI custody clears a per-source delete outside the public capability set once the worker is inactive', () => {
    const publicIds = new Set<string>(V0_4_PUBLIC_SOURCE_CAPABILITIES.map((capability) => capability.source_id));
    const source = lifecycleSourceSpecs().find((spec) =>
      spec.connectorStorePaths !== undefined
      && !publicIds.has(spec.sourceId)
      && !(spec.sourceAliases ?? []).some((alias) => publicIds.has(alias))
    );
    // The public runtime build ships only sources that have a public
    // capability, so there is no fall-through source there to exercise.
    if (!source) return;
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-delete-source-worker-custody-'));
    const homeDir = join(dir, 'home');
    try {
      const dbPath = source.connectorStorePaths!({ homeDir })[0]!;
      mkdirSync(dirname(dbPath), { recursive: true });
      writeFileSync(dbPath, 'connector store');

      const preview = deleteOlympusDataWithCustody({ sourceId: source.sourceId, homeDir, dryRun: true });
      expect(preview.custody).toMatchObject({
        requirement: 'worker_inactive',
        ready: false,
        observed: 'unknown',
      });
      expect(() => deleteOlympusDataWithCustody({ sourceId: source.sourceId, homeDir }))
        .toThrow('Stop or uninstall the Olympus worker');
      expect(() => deleteOlympusDataWithCustody({ sourceId: source.sourceId, homeDir, workerState: 'active' }))
        .toThrow('Stop or uninstall the Olympus worker');
      expect(existsSync(dbPath)).toBe(true);

      const deleted = deleteOlympusDataWithCustody({
        sourceId: source.sourceId,
        homeDir,
        workerState: 'inactive',
      });
      expect(deleted.custody).toEqual({
        requirement: 'worker_inactive',
        ready: true,
        observed: 'inactive',
      });
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every registered source id resolves to one lifecycle owner', () => {
    const lifecycleIds = new Set(lifecycleSourceSpecs().flatMap((source) => [
      source.sourceId,
      ...(source.sourceAliases ?? []),
    ]));
    const registeredSourceIds = new Set(
      defaultSourceCorpusRegistryConfig().corpora.map((corpus) => corpus.sourceId),
    );
    expect([...registeredSourceIds].filter((sourceId) => !lifecycleIds.has(sourceId))).toEqual([]);
    expect(lifecycleIds.has('whatsapp.personal.messages')).toBe(true);
  });

  test('export writes per-source archives and excludes secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-export-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const source = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'dropbox.files')!;
      const dbPath = source.connectorStorePaths!({ homeDir })[0]!;
      mkdirSync(join(homeDir, '.olympus', 'sources'), { recursive: true });
      mkdirSync(join(homeDir, '.config', 'olympus'), { recursive: true });
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new Database(dbPath, { create: true });
      db.exec('CREATE TABLE preserved (value TEXT NOT NULL);');
      db.query('INSERT INTO preserved (value) VALUES (?)').run('db bytes');
      db.close();
      writeFileSync(join(homeDir, '.olympus', 'sources', 'dropbox.personal.ingestion.json'), JSON.stringify({
        schemaVersion: 1,
        source: 'dropbox.personal',
        token: 'do-not-export',
        private_key: '-----BEGIN PRIVATE KEY-----\npolicy-private-key\n-----END PRIVATE KEY-----',
        credentials: {
          client_email: 'policy-service-account@example.test',
        },
        secretRef: 'env:DROPBOX_TOKEN',
      }));
      writeFileSync(join(homeDir, '.olympus', 'config.json'), JSON.stringify({
        worker: { authToken: 'worker-secret' },
        gcp: {
          credential: 'inline-credential-secret',
          service_account_json: {
            private_key: '-----BEGIN PRIVATE KEY-----\nconfig-private-key\n-----END PRIVATE KEY-----',
            client_email: 'config-service-account@example.test',
          },
        },
        sourceIndex: { answerDevEnabled: true },
      }));
      writeFileSync(join(homeDir, '.olympus', 'sovereignty.json'), JSON.stringify({
        schemaVersion: 1,
        modelProfiles: {
          private: {
            secretRef: 'env:VENICE_API_KEY',
            apiKey: 'inline-secret',
            note: '-----BEGIN OPENSSH PRIVATE KEY-----\nsovereignty-private-key\n-----END OPENSSH PRIVATE KEY-----',
          },
        },
      }));
      writeFileSync(join(homeDir, '.config', 'olympus', 'secrets.enc'), 'secret-store');

      const result = exportOlympusData({ destination, sourceId: 'dropbox.files', homeDir });
      const exportedText = readAllFiles(destination).join('\n');

      expect(result.sourceIds).toEqual(['dropbox.files']);
      expect(exportedText).toContain('secrets_excluded');
      expect(exportedText).toContain('env:VENICE_API_KEY');
      expect(exportedText).not.toContain('worker-secret');
      expect(exportedText).not.toContain('inline-secret');
      expect(exportedText).not.toContain('do-not-export');
      expect(exportedText).not.toContain('policy-private-key');
      expect(exportedText).not.toContain('policy-service-account@example.test');
      expect(exportedText).not.toContain('inline-credential-secret');
      expect(exportedText).not.toContain('config-private-key');
      expect(exportedText).not.toContain('config-service-account@example.test');
      expect(exportedText).not.toContain('sovereignty-private-key');
      expect(exportedText).not.toContain('secret-store');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete --all leaves zero Olympus files in known roots and unit targets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-delete-all-'));
    const homeDir = join(dir, 'home');
    try {
      mkdirSync(homeDir, { recursive: true });
      const installedWorker = installWorkerService({
        platform: 'darwin',
        homeDir,
        authToken: 'delete-all-token',
        dryRun: false,
      });
      const legacyLaunchAgent = join(homeDir, 'Library', 'LaunchAgents', 'org.openclaw.olympus.worker.plist');
      const systemdUnit = workerServicePaths('linux', homeDir).unitPath;
      const whatsappStore = join(homeDir, '.local', 'share', 'olympus', 'whatsapp-live', 'connector-store.db');
      const domainLibraryStore = join(homeDir, '.local', 'share', 'olympus', 'domain-library', 'connector-store.db');
      const linuxWorkerLog = join(homeDir, '.local', 'state', 'olympus', 'worker', 'worker.log');
      const macWorkerLog = join(homeDir, 'Library', 'Logs', 'Olympus', 'worker.log');
      for (const root of knownOlympusDataRoots({ homeDir })) {
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'owned-file'), 'owned');
      }
      for (const path of [whatsappStore, domainLibraryStore, linuxWorkerLog, macWorkerLog]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'private local state');
      }
      mkdirSync(dirname(legacyLaunchAgent), { recursive: true });
      mkdirSync(dirname(systemdUnit), { recursive: true });
      writeFileSync(legacyLaunchAgent, 'unit');
      writeFileSync(systemdUnit, 'unit');

      const dryRun = deleteOlympusData({ all: true, homeDir, dryRun: true });
      expect(dryRun.dryRun).toBe(true);
      expect(dryRun.removed).toContain(join(homeDir, '.local', 'share', 'olympus'));
      expect(dryRun.removed).toContain(join(homeDir, '.local', 'state', 'olympus'));
      expect(dryRun.removed).toContain(join(homeDir, 'Library', 'Logs', 'Olympus'));
      expect(existsSync(whatsappStore)).toBe(true);
      expect(existsSync(domainLibraryStore)).toBe(true);
      expect(existsSync(linuxWorkerLog)).toBe(true);
      expect(existsSync(macWorkerLog)).toBe(true);

      const result = deleteOlympusData({ all: true, homeDir });

      expect(result.removed.length).toBeGreaterThanOrEqual(6);
      expect(result.removed).toContain(installedWorker.unit_path);
      expect(knownOlympusDataRoots({ homeDir }).filter(existsSync)).toEqual([]);
      expect(existsSync(whatsappStore)).toBe(false);
      expect(existsSync(domainLibraryStore)).toBe(false);
      expect(existsSync(linuxWorkerLog)).toBe(false);
      expect(existsSync(macWorkerLog)).toBe(false);
      expect(existsSync(installedWorker.unit_path)).toBe(false);
      expect(existsSync(legacyLaunchAgent)).toBe(false);
      expect(existsSync(systemdUnit)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete --all removes env-overridden source databases outside known roots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-delete-all-env-'));
    const homeDir = join(dir, 'home');
    const emailDb = join(dir, 'external-indexes', 'gmail.sqlite');
    try {
      mkdirSync(dirname(emailDb), { recursive: true });
      createMarkedSqliteStore(emailDb, 'connector-store');
      writeFileSync(`${emailDb}-wal`, 'wal');
      writeFileSync(`${emailDb}-shm`, 'shm');

      const result = deleteOlympusData({
        all: true,
        homeDir,
        env: {
          OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_DB_PATH: emailDb,
        },
      });

      expect(result.mode).toBe('all');
      expect(result.removed).toContain(emailDb);
      expect(result.removed).toContain(`${emailDb}-wal`);
      expect(result.removed).toContain(`${emailDb}-shm`);
      expect(existsSync(emailDb)).toBe(false);
      expect(existsSync(`${emailDb}-wal`)).toBe(false);
      expect(existsSync(`${emailDb}-shm`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete --all refuses unsafe env-overridden source paths outside known roots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-delete-all-unsafe-env-'));
    const homeDir = join(dir, 'home');
    try {
      const nonSqlite = join(dir, 'external-indexes', 'not-sqlite.db');
      const directoryPath = join(dir, 'external-indexes', 'directory.sqlite');
      const symlinkPath = join(dir, 'external-indexes', 'symlink.sqlite');
      mkdirSync(dirname(nonSqlite), { recursive: true });
      writeFileSync(nonSqlite, 'not a sqlite database');
      mkdirSync(directoryPath, { recursive: true });
      symlinkSync(nonSqlite, symlinkPath);

      for (const emailDb of [nonSqlite, directoryPath, symlinkPath]) {
        expect(() => deleteOlympusData({
          all: true,
          homeDir,
          env: {
            OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_DB_PATH: emailDb,
          },
        })).toThrow('Refusing to delete');
      }

      expect(existsSync(nonSqlite)).toBe(true);
      expect(existsSync(directoryPath)).toBe(true);
      expect(existsSync(symlinkPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete --source removes only that source files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-delete-source-'));
    const homeDir = join(dir, 'home');
    try {
      const dropbox = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'dropbox.files')!;
      const gmail = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'gmail.email')!;
      const dropboxPath = dropbox.connectorStorePaths!({ homeDir })[0]!;
      const gmailPath = gmail.connectorStorePaths!({ homeDir })[0]!;
      mkdirSync(dirname(dropboxPath), { recursive: true });
      writeFileSync(dropboxPath, 'dropbox');
      writeFileSync(gmailPath, 'gmail');
      mkdirSync(join(homeDir, '.olympus', 'sources'), { recursive: true });
      writeFileSync(join(homeDir, '.olympus', 'sources', 'dropbox.personal.ingestion.json'), '{}');

      const result = deleteOlympusData({ sourceId: 'dropbox.files', homeDir });

      expect(result.mode).toBe('source');
      expect(existsSync(dropboxPath)).toBe(false);
      expect(existsSync(join(homeDir, '.olympus', 'sources', 'dropbox.personal.ingestion.json'))).toBe(false);
      expect(existsSync(gmailPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete --all confirmation requires both phrases', () => {
    expect(() => validateDeleteAllConfirmations('DELETE OLYMPUS DATA', 'DELETE EVERYTHING')).not.toThrow();
    expect(() => validateDeleteAllConfirmations('DELETE OLYMPUS DATA', 'no')).toThrow(/requires both confirmation/);
  });

  // Slice 2 deleted the code that READ the grandfathered per-family indexes,
  // not the files themselves: every install upgraded across that cut still
  // holds them in `~/.local/share/openclaw/olympus`, a root `delete --all`
  // removes recursively. The registry that lost them is the registry export
  // and per-source delete walk, so this pins them back into the inventory
  // while keeping them out of the migration loop, where they were never
  // supposed to be again.
  test('every family that owned a legacy per-family index still declares it', () => {
    const homeDir = '/tmp/olympus-lifecycle-legacy-shape';
    const declared = new Map(
      lifecycleSourceSpecs()
        .filter((source) => source.sqlitePath !== undefined)
        .map((source) => [source.sourceId, {
          path: source.sqlitePath!({ homeDir }),
          storeId: source.legacySqliteStoreId,
        }]),
    );

    expect([...declared.keys()].sort()).toEqual([
      'dropbox.files',
      'gmail.email',
      'google_drive.docs',
      'readwise.library',
      'telegram.messages',
    ]);
    const root = join(homeDir, '.local', 'share', 'openclaw', 'olympus');
    expect(declared.get('gmail.email')).toEqual({
      path: join(root, 'email-index.sqlite'),
      storeId: 'email-index',
    });
    expect(declared.get('dropbox.files')).toEqual({
      path: join(root, 'dropbox-files-index.sqlite'),
      storeId: 'dropbox-files-index',
    });
    expect(declared.get('google_drive.docs')).toEqual({
      path: join(root, 'google-drive-docs-index.sqlite'),
      storeId: 'google-drive-docs-index',
    });
    expect(declared.get('telegram.messages')).toEqual({
      path: join(root, 'telegram-messages-index.sqlite'),
      storeId: 'telegram-messages-index',
    });
    expect(declared.get('readwise.library')).toEqual({
      path: join(root, 'readwise-index.sqlite'),
      storeId: 'readwise-index',
    });
  });

  // A legacy index is a custody artifact, not a store this build owns. The
  // live ones on an upgraded host sit at schema_version 2 under their own
  // retired store ids, so migrating them would either write connector-store
  // migrations into a stranger's schema or refuse outright — and either way
  // it mutates bytes whose only remaining job is to survive until they are
  // exported and deleted.
  test('migrate never touches the legacy per-family indexes it must still preserve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-migrate-'));
    const homeDir = join(dir, 'home');
    try {
      const context = { homeDir };
      for (const source of lifecycleSourceSpecs()) {
        const legacyPath = source.sqlitePath?.(context);
        if (!legacyPath) continue;
        mkdirSync(dirname(legacyPath), { recursive: true });
        createMarkedSqliteStore(legacyPath, source.legacySqliteStoreId!);
      }

      const dryRun = runDataMigrations({ dryRun: true, ...context });
      expect(dryRun.ok).toBe(true);
      expect(dryRun.dryRun).toBe(true);
      expect(dryRun.stores).toEqual([]);
      expect(dryRun.skipped).toEqual([]);

      const applied = runDataMigrations({ dryRun: false, ...context });
      expect(applied.stores).toEqual([]);
      expect(applied.skipped).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('export copies the legacy per-family index an upgraded install still holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-export-legacy-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const gmail = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'gmail.email')!;
      const legacyPath = gmail.sqlitePath!({ homeDir });
      mkdirSync(dirname(legacyPath), { recursive: true });
      createMarkedSqliteStore(legacyPath, gmail.legacySqliteStoreId!);
      const seeded = new Database(legacyPath);
      seeded.exec('CREATE TABLE preserved (value TEXT NOT NULL);');
      seeded.query('INSERT INTO preserved (value) VALUES (?)').run('pre-cutover mail');
      seeded.close();

      const result = exportOlympusData({ destination, sourceId: 'gmail.email', homeDir });

      const copied = join(destination, 'sources', 'gmail.email', 'email-index.sqlite');
      expect(result.files).toContain(copied);
      expect(result.artifacts.some((artifact) =>
        artifact.role === 'legacy_store'
        && artifact.relativePath === join('sources', 'gmail.email', 'email-index.sqlite')
        && artifact.sqlite?.expectedStoreId === 'email-index')).toBe(true);
      const snapshot = new Database(copied, { readonly: true });
      try {
        expect(snapshot.query('SELECT value FROM preserved').all()).toEqual([{ value: 'pre-cutover mail' }]);
      } finally {
        snapshot.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('export names the legacy per-family index it did not find', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-export-legacy-absent-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const gmail = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'gmail.email')!;
      const legacyPath = gmail.sqlitePath!({ homeDir });

      const result = exportOlympusData({ destination, sourceId: 'gmail.email', homeDir });

      for (const path of [legacyPath, `${legacyPath}-wal`, `${legacyPath}-shm`]) {
        expect(result.skipped).toContain(path);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete --source removes that family legacy per-family index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-delete-legacy-'));
    const homeDir = join(dir, 'home');
    try {
      const gmail = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'gmail.email')!;
      const dropbox = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'dropbox.files')!;
      const gmailLegacy = gmail.sqlitePath!({ homeDir });
      const dropboxLegacy = dropbox.sqlitePath!({ homeDir });
      mkdirSync(dirname(gmailLegacy), { recursive: true });
      for (const path of [gmailLegacy, dropboxLegacy]) writeFileSync(path, 'legacy index');
      writeFileSync(`${gmailLegacy}-wal`, 'wal');
      writeFileSync(`${gmailLegacy}-shm`, 'shm');

      const result = deleteOlympusData({ sourceId: 'gmail.email', homeDir });

      expect(result.removed).toContain(gmailLegacy);
      expect(existsSync(gmailLegacy)).toBe(false);
      expect(existsSync(`${gmailLegacy}-wal`)).toBe(false);
      expect(existsSync(`${gmailLegacy}-shm`)).toBe(false);
      expect(existsSync(dropboxLegacy)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The WhatsApp incident in the source comments, one layer down: a private
  // file that no spec names is copied by nothing and reported as nothing,
  // while `delete --all` takes the whole root it sits in. The round trip is
  // the only place that failure is visible, so it is asserted end to end.
  test('export then delete --all destroys no legacy index the manifest did not name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-legacy-round-trip-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const legacyPaths = lifecycleSourceSpecs()
        .map((source) => source.sqlitePath?.({ homeDir }))
        .filter((path): path is string => path !== undefined);
      expect(legacyPaths.length).toBeGreaterThan(0);
      for (const path of legacyPaths) {
        mkdirSync(dirname(path), { recursive: true });
        const db = new Database(path, { create: true });
        db.exec('CREATE TABLE preserved (value TEXT NOT NULL);');
        db.query('INSERT INTO preserved (value) VALUES (?)').run(`legacy bytes for ${path}`);
        db.close();
      }

      const exported = exportOlympusData({ destination, homeDir });
      const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as {
        files: string[];
        skipped: string[];
      };
      const copiedNames = new Set(manifest.files.map((file) => file.split('/').pop()!));

      deleteOlympusData({ all: true, homeDir });

      for (const path of legacyPaths) {
        expect(existsSync(path)).toBe(false);
        const named = copiedNames.has(path.split('/').pop()!) || manifest.skipped.includes(path);
        expect(`${path}:${named}`).toBe(`${path}:true`);
      }
      expect(exported.artifacts.filter((artifact) => artifact.role === 'legacy_store'))
        .toHaveLength(legacyPaths.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migrate skips every store that does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-data-migrate-absent-'));
    try {
      const result = runDataMigrations({ dryRun: true, homeDir: join(dir, 'home') });
      expect(result.stores).toEqual([]);
      expect(result.skipped).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function readAllFiles(root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...readAllFiles(path));
    } else {
      results.push(readFileSync(path, 'utf8'));
    }
  }
  return results;
}

function createMarkedSqliteStore(path: string, storeId: string): void {
  const db = new Database(path);
  try {
    runSqliteMigrations(db, storeId, currentStoreMigrations());
  } finally {
    db.close();
  }
}
