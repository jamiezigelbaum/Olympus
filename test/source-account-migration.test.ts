// The boot migration of existing accounts into their folders (docs/design/
// source-storage.md, "Migration of existing installs"; delivery step 4c).
// Everything runs on a throwaway data folder: real SQLite stores (some with a
// pending WAL, which the pass folds in first), real sidecars and raw state, the
// real registry, and the storage service's own refusals. Expected results are
// written from the design's rules (the move only renames files: after the log
// is folded in, the bytes of every store and ledger are what they were; a
// failed check puts everything back), not read back from the code under test.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { secretLocationsPathForStore, tierLedgerPathForStore, tierSnifferPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { archiveCorpusId, archiveImportFamilies } from '../src/core/archive-formats.ts';
import { publishLinuxEngineReceipt, resolveLinuxEngineLayout, standaloneLinuxDataDir } from '../src/core/linux-engine-layout.ts';
import { mediaCacheDir, releaseMediaCacheFile, retainMediaCacheFile, sweepMediaCache, writeMediaCacheFile } from '../src/core/media-cache.ts';
import {
  accountFolder,
  legacyAccountFiles,
  migratableSources,
  olympusDataRoot,
  type LayoutEnv,
} from '../src/core/olympus-layout.ts';
import { resolvedRawPath, resolvedStorePath } from '../src/core/source-placement.ts';
import {
  AccountMigrationKilled,
  LOCK_WAIT_CAP_MS,
  MIGRATE_ACCOUNT_FOLDERS_ENV,
  MIGRATION_BUDGET_MS,
  __accountMigrationTestHooks,
  migrateAccountFolders,
  type MigrationLook,
} from '../src/core/source-account-migration.ts';
import {
  SourceRegistryError,
  readSourceRegistry,
  sourceAccountMovePending,
  sourceRegistryPath,
  sourceStorageNotices,
  updateSourceRegistry,
  type SourceRegistryAccount,
  type SourceRegistryMove,
} from '../src/core/source-registry.ts';
import {
  SourceStorageUnavailableError,
  __sourceStorageTestHooks,
  isSourceAccountOpenable,
  openConnectorStore,
  replaceEmptyLegacyAccounts,
  sourceAccountUnavailableReason,
  storeFileReads,
} from '../src/core/source-storage.ts';
import { placedStoreHolder, type StoreHolder } from '../src/core/store-identity.ts';
import { deleteOlympusData, exportOlympusData } from '../src/data-lifecycle.ts';
import { SqliteSourceDashboardHistory, defaultSourceDashboardHistoryDbPath } from '../src/workers/source-dashboard.ts';
import { migrateAccountFoldersAtBoot } from '../src/workers/email-source/server.ts';

type Env = Record<string, string>;

const roots: string[] = [];
afterEach(() => {
  __accountMigrationTestHooks.reset();
  __sourceStorageTestHooks.disableAdoption();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(extra: Env = {}): { dir: string; env: Env; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-account-migration-'));
  roots.push(dir);
  const home = join(dir, 'home');
  const env: Env = {
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    PATH: process.env.PATH ?? '',
    [MIGRATE_ACCOUNT_FOLDERS_ENV]: '1',
    ...extra,
  };
  return { dir, env, root: olympusDataRoot(env) };
}

const withoutSwitch = (env: Env): Env => {
  const { [MIGRATE_ACCOUNT_FOLDERS_ENV]: _removed, ...rest } = env;
  return rest;
};

// ---------------------------------------------------------------------------
// A legacy install

/** A SQLite file with rows in it; `pendingWal` leaves its rows in a `-wal` (and `-shm`) beside it, as a killed engine would. */
function sqliteFile(path: string, options: { rows?: number; pendingWal?: boolean } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const rows = options.rows ?? 3;
  const live = options.pendingWal ? join(mkdtempSync(join(tmpdir(), 'olympus-wal-')), 'live.sqlite') : path;
  const db = new Database(live);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v TEXT)');
  for (let index = 0; index < rows; index += 1) db.query('INSERT INTO t VALUES (?)').run(`${basename(path)}-${index}`);
  if (options.pendingWal) {
    // Copy while the connection still holds its WAL: what a crash leaves behind.
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${live}${suffix}`)) copyFileSync(`${live}${suffix}`, `${path}${suffix}`);
    db.close();
    rmSync(dirname(live), { recursive: true, force: true });
    return;
  }
  // As the engine leaves a store it closed: checkpointed, with its empty `-wal` and its `-shm` beside it.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

/** The rows of the test table. Opened writable but query-only: a read-only connection cannot open a WAL database with no `-wal` beside it on macOS. */
function rowsOf(path: string): number {
  const db = new Database(path, { readwrite: true });
  try {
    db.exec('PRAGMA query_only = ON');
    return (db.query('SELECT count(*) AS n FROM t').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Every file the layout says an account of this source owns at its legacy places, created for real. Returns what it made. */
function seedLegacy(env: Env, sourceId: string, options: { walOn?: 'first' | 'all' | 'none' } = {}): string[] {
  const made: string[] = [];
  let first = true;
  for (const file of legacyAccountFiles(sourceId, env, archiveImportFamilies())) {
    if (file.area === 'store') {
      const wal = (options.walOn ?? 'first') === 'all' || ((options.walOn ?? 'first') === 'first' && first);
      first = false;
      sqliteFile(file.legacy, { pendingWal: wal });
      for (const sidecar of [tierLedgerPathForStore(file.legacy), secretLocationsPathForStore(file.legacy), tierSnifferPathForStore(file.legacy)]) sqliteFile(sidecar, { rows: 2 });
      made.push(file.legacy, `${file.legacy}-wal`, `${file.legacy}-shm`, tierLedgerPathForStore(file.legacy), secretLocationsPathForStore(file.legacy), tierSnifferPathForStore(file.legacy));
    } else if (file.rawKind === 'dir') {
      mkdirSync(file.legacy, { recursive: true });
      writeFileSync(join(file.legacy, 'a.snap'), 'first snapshot');
      writeFileSync(join(file.legacy, 'b.snap'), 'second snapshot');
      made.push(file.legacy);
    } else if (file.rawKind === 'db') {
      sqliteFile(file.legacy);
      made.push(file.legacy);
    } else {
      mkdirSync(dirname(file.legacy), { recursive: true });
      writeFileSync(file.legacy, `{"state":"${basename(file.legacy)}"}\n`);
      made.push(file.legacy);
    }
  }
  return made.filter((path) => existsSync(path));
}

/** The registry as a build from before the migration leaves it: the account listed `legacy`, with its corpora. */
function recordLegacy(env: Env, sourceId: string, corpusIds?: string[]): void {
  const tiers = [...new Set(legacyAccountFiles(sourceId, env, archiveImportFamilies()).filter((file) => file.area === 'store').map((file) => file.name.split('.').pop()!))];
  updateSourceRegistry(env, (registry) => {
    registry.accounts.push({
      source_id: sourceId,
      slot: '1',
      state: 'active',
      layout: 'legacy',
      corpus_ids: corpusIds ?? (sourceId === 'archive.imports' ? [] : tiers.map((tier) => `${tier}.${sourceId}`)),
      created_at: '2026-10-01T00:00:00.000Z',
    });
  });
}

function install(env: Env, sourceId: string, options: { walOn?: 'first' | 'all' | 'none'; corpusIds?: string[] } = {}): string[] {
  const made = seedLegacy(env, sourceId, options);
  recordLegacy(env, sourceId, options.corpusIds);
  return made;
}

/**
 * Files and folders under a path with what they are: `dir`, or `dev:ino:size` and the bytes. SQLite's own
 * scratch files are left out: a `-shm` (the index it rebuilds from the `-wal` whenever a connection opens)
 * and an empty `-wal`. Any open, a read-only check included, may make or rewrite them; a `-wal` with
 * content is the store's and is compared like any other file.
 */
function tree(root: string): Record<string, string> {
  const seen: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = relative(root, path);
      const stat = lstatSync(path);
      if (entry.isDirectory()) {
        seen[key] = 'dir';
        walk(path);
      } else if (!entry.name.endsWith('-shm') && !(entry.name.endsWith('-wal') && stat.size === 0)) {
        seen[key] = `${stat.dev}:${stat.ino}:${stat.size}:${readFileSync(path).toString('base64')}`;
      }
    }
  };
  walk(root);
  return seen;
}

const identity = (path: string): string => {
  const stat = lstatSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.isDirectory() ? 0 : stat.size}`;
};

const destinationOf = (env: Env, legacy: string, sourceId: string): string => {
  const root = olympusDataRoot(env);
  const rel = relative(root, legacy);
  const base = rel.replace(/-(wal|shm|journal)$/, '');
  const suffix = rel.slice(base.length);
  const file = legacyAccountFiles(sourceId, env, archiveImportFamilies()).find((entry) => base === relative(root, entry.legacy)
    || (entry.area === 'store' && [tierLedgerPathForStore, secretLocationsPathForStore, tierSnifferPathForStore].some((sidecar) => base === relative(root, sidecar(entry.legacy)))));
  if (!file) throw new Error(`no destination for ${rel}`);
  const folder = accountFolder({ source_id: sourceId, slot: '1' }, env);
  const place = file.area === 'store'
    ? join(folder, 'stores', `${file.name}.sqlite`)
    : join(folder, 'raw', file.name);
  const stem = place.endsWith('.sqlite') ? place.slice(0, -'.sqlite'.length) : place;
  if (base === relative(root, file.legacy)) return `${place}${suffix}`;
  if (base === relative(root, tierLedgerPathForStore(file.legacy))) return `${stem}.tier-ledger.sqlite${suffix}`;
  if (base === relative(root, secretLocationsPathForStore(file.legacy))) return `${stem}.secret-locations.sqlite${suffix}`;
  return `${stem}.tier-sniffer.sqlite${suffix}`;
};

const entryOf = (env: Env, sourceId: string): SourceRegistryAccount | undefined =>
  readSourceRegistry(env).accounts.find((account) => account.source_id === sourceId);

/** `dev:ino` of a path: which file it is, whatever its size (folding a log into a database changes the file's size, not which file it is). */
const inode = (path: string): string => {
  const stat = lstatSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

const isCompanionPath = (path: string): boolean => /-(wal|shm|journal)$/.test(path);

/** The files whose bytes a move must not change: databases, sidecars and raw state, not SQLite's own `-wal`, `-shm` and `-journal`. */
const contentFiles = (paths: string[]): string[] => paths.filter((path) => !isCompanionPath(path) && lstatSync(path).isFile());

/** Adds a handler to the pass's checkpoints; the ones set before it run first, so a handler that kills the pass goes last. */
function onCheckpoint(handler: (at: string) => void): void {
  const previous = __accountMigrationTestHooks.checkpoint;
  __accountMigrationTestHooks.checkpoint = (at) => {
    previous?.(at);
    handler(at);
  };
}

/**
 * The bytes of every given file once the pass has folded the logs in (its `folded` step), keyed by the file's old
 * path. After the fold the move writes nothing to a database: the same bytes must be where the files end up.
 */
function foldedDigests(paths: string[]): Map<string, string> {
  const digests = new Map<string, string>();
  onCheckpoint((at) => {
    if (at !== 'folded' || digests.size > 0) return;
    for (const path of contentFiles(paths.filter((file) => existsSync(file)))) digests.set(path, digest(path));
  });
  return digests;
}

/** That every file whose bytes were taken at the fold has the same bytes at its new place (`folder`) or its old one (`legacy`). */
function expectBytesKept(env: Env, sourceId: string, folded: Map<string, string>, where: 'folder' | 'legacy', label = ''): void {
  expect(folded.size, `${label}: the fold was not reached`).toBeGreaterThan(0);
  for (const [legacy, bytes] of folded) {
    const place = where === 'folder' ? destinationOf(env, legacy, sourceId) : legacy;
    expect(existsSync(place), `${label}: ${place} is missing`).toBe(true);
    expect(digest(place), `${label}: ${place} changed`).toBe(bytes);
  }
}

/** Makes every file at its place in the account folder read as another size, so the identity check fails with nothing changed on disk. */
function lieAboutSizes(env: Env, sourceId: string): void {
  const folder = accountFolder({ source_id: sourceId, slot: '1' }, env);
  __accountMigrationTestHooks.look = (path, actual): MigrationLook | undefined => (
    path.startsWith(`${folder}/`) && !isCompanionPath(path) && actual.kind === 'file'
      ? { ...actual, size: actual.size + 1n }
      : undefined
  );
}

/** Whether every database of an account opens, at the place `where` says it is. */
function expectDatabasesOpen(env: Env, sourceId: string, legacy: string[], where: 'folder' | 'legacy', label = ''): void {
  const databases = legacy.filter((path) => path.endsWith('.sqlite') && existsSync(where === 'legacy' ? path : destinationOf(env, path, sourceId)));
  expect(databases.length, label).toBeGreaterThan(0);
  for (const path of databases) {
    const place = where === 'folder' ? destinationOf(env, path, sourceId) : path;
    expect(storeFileReads(place), `${label}: ${place} does not open`).toBe('reads');
  }
}

// ---------------------------------------------------------------------------

describe('the move', () => {
  test.each(migratableSources().map((sourceId) => [sourceId]))('%s: every file is renamed into its folder, same file, nothing copied, and no store or ledger is written to beyond the log fold', (sourceId) => {
    const { env, root } = fixture();
    const legacy = install(env, sourceId);
    // The same file (its inode) before and after; the bytes are compared from the fold on, which is the only write to a database.
    const before = new Map(contentFiles(legacy).map((path) => [path, inode(path)]));
    const folded = foldedDigests(legacy);
    // Shared files and pre-1.0 index files in the same folder are not the account's.
    const bystanders = ['x-bookmarks-api-usage.sqlite', 'source-watches.sqlite', 'email-index.sqlite', 'file-source-scopes.json']
      .map((name) => join(root, name));
    for (const path of bystanders) writeFileSync(path, `bytes of ${basename(path)}`);
    const bystanderTree = Object.fromEntries(bystanders.map((path) => [path, tree(root)[relative(root, path)]]));

    const report = migrateAccountFolders(env);

    expect(report, JSON.stringify(report)).toMatchObject({ moved: [sourceId] });
    expect(report.errors).toEqual([]);
    expect(report.movedBack).toEqual([]);
    expect(report.stuck).toEqual([]);
    for (const path of legacy) expect(existsSync(path), `${path} is still at its old place`).toBe(false);
    for (const [path, was] of before) {
      const moved = destinationOf(env, path, sourceId);
      expect(inode(moved), `${moved} is not the same file`).toBe(was);
    }
    // The move wrote nothing to any store, ledger, sidecar or raw file: their bytes are what they were once the logs were folded in.
    expectBytesKept(env, sourceId, folded, 'folder', sourceId);
    // The registry says so, in one entry, with the plan's end and no plan left.
    const entry = entryOf(env, sourceId)!;
    expect(entry.layout).toBe('folder');
    expect(entry.migration?.state).toBe('done');
    expect(entry.migration?.moves).toBeUndefined();
    expect(readSourceRegistry(env).schema).toBe(2);
    expect(JSON.parse(readFileSync(sourceRegistryPath(env), 'utf8')).schema).toBe(2);
    // Other accounts' and shared files are where they were, byte for byte.
    for (const path of bystanders) expect(tree(root)[relative(root, path)]).toBe(bystanderTree[path]!);
    // And the layout now resolves the account to its folder.
    const firstStore = legacyAccountFiles(sourceId, env, archiveImportFamilies()).find((file) => file.area === 'store')!;
    expect(resolvedStorePath(sourceId, firstStore.name, env)).toBe(join(accountFolder({ source_id: sourceId, slot: '1' }, env), 'stores', `${firstStore.name}.sqlite`));
    // A second boot has nothing to do and writes nothing.
    const registryBefore = readFileSync(sourceRegistryPath(env), 'utf8');
    const again = migrateAccountFolders(env);
    expect(again).toEqual({ moved: [], resumed: [], movedBack: [], skipped: [], stuck: [], deferred: [], errors: [] });
    expect(readFileSync(sourceRegistryPath(env), 'utf8')).toBe(registryBefore);
  });

  test('a store with rows only in its log: the log is folded into the database before anything moves, so the file alone holds every row', () => {
    const { dir, env } = fixture();
    const [store] = install(env, 'dropbox.files', { walOn: 'first' });
    expect(statSync(`${store}-wal`).size, 'the store has a pending log').toBeGreaterThan(0);
    const alone = join(dir, 'alone.sqlite');
    const seen: { log?: number; aloneRows?: number } = {};
    onCheckpoint((at) => {
      if (at !== 'folded') return;
      // After the fold and before the plan: the log is empty, and the database file by itself reads all three rows.
      seen.log = existsSync(`${store}-wal`) ? statSync(`${store}-wal`).size : 0;
      copyFileSync(store!, alone);
      seen.aloneRows = rowsOf(alone);
    });

    migrateAccountFolders(env);

    expect(seen).toEqual({ log: 0, aloneRows: 3 });
    const moved = resolvedStorePath('dropbox.files', 'secure_local', env);
    expect(existsSync(`${store}-wal`)).toBe(false);
    expect(rowsOf(moved)).toBe(3);
    // Where SQLite leaves a closed database's log beside it, what moved is empty; where it removes it, there is none.
    expect(existsSync(`${moved}-wal`) ? statSync(`${moved}-wal`).size : 0).toBe(0);
  });

  test('a store with no log or index file beside it (a clean close) moves, and opens at its new place', () => {
    const { env } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    for (const path of legacy.filter(isCompanionPath)) rmSync(path, { force: true });

    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);

    expectDatabasesOpen(env, 'dropbox.files', legacy, 'folder', 'moved');
    expect(rowsOf(resolvedStorePath('dropbox.files', 'secure_local', env))).toBe(3);
  });

  test('the tier sidecars of every tier follow their store, named for it', () => {
    const { env } = fixture();
    install(env, 'dropbox.files');
    migrateAccountFolders(env);
    const stores = join(accountFolder({ source_id: 'dropbox.files', slot: '1' }, env), 'stores');
    expect(readdirSync(stores).filter((name) => !/-(wal|shm)$/.test(name)).sort()).toEqual([
      'internal.secret-locations.sqlite',
      'internal.sqlite',
      'internal.tier-ledger.sqlite',
      'internal.tier-sniffer.sqlite',
      'public_safe.secret-locations.sqlite',
      'public_safe.sqlite',
      'public_safe.tier-ledger.sqlite',
      'public_safe.tier-sniffer.sqlite',
      'secure_local.secret-locations.sqlite',
      'secure_local.sqlite',
      'secure_local.tier-ledger.sqlite',
      'secure_local.tier-sniffer.sqlite',
    ]);
  });

  test('an imported archive keeps its family-and-tier store names and its state and queued requests', () => {
    const { env } = fixture();
    install(env, 'archive.imports');
    const family = archiveImportFamilies()[0]!;
    migrateAccountFolders(env);
    const folder = accountFolder({ source_id: 'archive.imports', slot: '1' }, env);
    expect(existsSync(join(folder, 'stores', `${family}.secure_local.sqlite`))).toBe(true);
    expect(readFileSync(join(folder, 'raw', 'archive-imports.json'), 'utf8')).toBe('{"state":"archive-imports.json"}\n');
    expect(readFileSync(join(folder, 'raw', 'archive-import-requests.json'), 'utf8')).toBe('{"state":"archive-import-requests.json"}\n');
    expect(resolvedRawPath('archive.imports', 'archive-imports.json', env)).toBe(join(folder, 'raw', 'archive-imports.json'));
  });

  test('local files: the watch snapshots move whole, and the layout reads them there', () => {
    const { env } = fixture();
    install(env, 'local.files');
    migrateAccountFolders(env);
    const watch = resolvedRawPath('local.files', 'watch', env);
    expect(watch).toBe(join(accountFolder({ source_id: 'local.files', slot: '1' }, env), 'raw', 'watch'));
    expect(readdirSync(watch).sort()).toEqual(['a.snap', 'b.snap']);
    expect(readFileSync(join(watch, 'a.snap'), 'utf8')).toBe('first snapshot');
  });

  test('X: only the reconcile state moves; the usage ledger stays where it is, shared', () => {
    const { env, root } = fixture();
    install(env, 'x.bookmarks');
    const usage = join(root, 'x-bookmarks-api-usage.sqlite');
    sqliteFile(usage);
    const usageBefore = identity(usage);
    migrateAccountFolders(env);
    const folder = accountFolder({ source_id: 'x.bookmarks', slot: '1' }, env);
    expect(rowsOf(join(folder, 'raw', 'x-reconcile.sqlite'))).toBe(3);
    expect(existsSync(`${usage}.reconcile`)).toBe(false);
    expect(identity(usage)).toBe(usageBefore);
  });

  test('pre-1.0 index files and the settings files are never touched', () => {
    const { env, root } = fixture();
    install(env, 'gmail.email');
    const left = ['email-index.sqlite', 'dropbox-files-index.sqlite', 'mail-source-scopes.json', 'source-account-bindings.json'].map((name) => join(root, name));
    for (const path of left) writeFileSync(path, `old ${basename(path)}`);
    const before = left.map(identity);
    migrateAccountFolders(env);
    expect(left.map(identity)).toEqual(before);
  });

  test('the dashboard\'s history is shared, not the account\'s: it stays, and its samples are all still there', () => {
    const { env } = fixture();
    install(env, 'dropbox.files');
    const path = defaultSourceDashboardHistoryDbPath(env);
    const history = new SqliteSourceDashboardHistory(path);
    history.record([{
      source_id: 'dropbox.files',
      corpus_id: 'internal.dropbox.files',
      sampled_at: '2026-10-20T10:00:00.000Z',
      indexed_items: 120,
      content_ready_items: 100,
      queue_waiting: 3,
      queue_active: 1,
      queue_attention: 0,
    }]);
    const before = history.sampleCount();
    const identityBefore = identity(path);
    expect(before).toBe(1);

    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);

    expect(identity(path)).toBe(identityBefore);
    expect(history.sampleCount()).toBe(before);
    expect(new SqliteSourceDashboardHistory(path).sampleCount()).toBe(before);
  });

  test('the account is a folder only once everything has moved: the entry never says folder with a plan pending', () => {
    const { env } = fixture();
    install(env, 'dropbox.files');
    const seen: string[] = [];
    __accountMigrationTestHooks.checkpoint = (at) => {
      const entry = entryOf(env, 'dropbox.files')!;
      seen.push(`${at}:${entry.layout}:${entry.migration?.state}`);
      if (at !== 'flipped') expect(entry.layout).toBe('legacy');
    };
    migrateAccountFolders(env);
    expect(seen.slice(0, 2)).toEqual(['folded:legacy:undefined', 'plan:legacy:moving']);
    expect(seen.at(-1)).toBe('flipped:folder:done');
    expect(seen.filter((line) => line.endsWith(':folder:done'))).toHaveLength(1);
  });
});

describe('with the switch off', () => {
  test.each([
    ['not set', undefined],
    ['0', '0'],
    ['true', 'true'],
    ['empty', ''],
  ])('%s: the boot changes nothing, not a path, a byte or the registry', (_label, value) => {
    const { env, root } = fixture();
    for (const sourceId of migratableSources()) install(env, sourceId);
    const clean = withoutSwitch(env);
    const switched = value === undefined ? clean : { ...clean, [MIGRATE_ACCOUNT_FOLDERS_ENV]: value };
    const before = tree(root);

    const report = migrateAccountFolders(switched);

    expect(report).toEqual({ moved: [], resumed: [], movedBack: [], skipped: [], stuck: [], deferred: [], errors: [] });
    expect(tree(root)).toEqual(before);
    // Every account still resolves to the paths that were always there.
    expect(resolvedStorePath('dropbox.files', 'secure_local', switched)).toBe(join(root, 'dropbox-files-connector-store.sqlite'));
  });

  test('a boot with no registry and no data folder writes nothing at all', () => {
    const { env, root } = fixture();
    migrateAccountFolders(withoutSwitch(env));
    expect(existsSync(root)).toBe(false);
  });

  test('a move that is part way is still finished: its account is closed until a boot does', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files');
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'rename:2') throw new AccountMigrationKilled(at);
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    expect(sourceAccountMovePending(entryOf(env, 'dropbox.files')!)).toBe(true);

    const report = migrateAccountFolders(withoutSwitch(env));

    expect(report.resumed).toEqual(['dropbox.files']);
    expect(entryOf(env, 'dropbox.files')!.layout).toBe('folder');
    for (const path of legacy) expect(existsSync(path), path).toBe(false);
    expect(existsSync(join(root, 'dropbox-files-connector-store.sqlite'))).toBe(false);
  });
});

describe('a crash at any step', () => {
  /** The labels a clean run passes, in order. */
  function labelsOf(sourceId: string): string[] {
    const { env } = fixture();
    install(env, sourceId, { walOn: 'all' });
    const labels: string[] = [];
    __accountMigrationTestHooks.checkpoint = (at) => { labels.push(at); };
    migrateAccountFolders(env);
    __accountMigrationTestHooks.reset();
    return labels;
  }

  test('the steps are named: the fold, the plan, every rename, the checks and the flip', () => {
    const labels = labelsOf('dropbox.files');
    expect(labels.slice(0, 2)).toEqual(['folded', 'plan']);
    expect(labels.filter((label) => label.startsWith('rename:'))).toHaveLength(labels.length - 4);
    expect(labels.slice(-2)).toEqual(['verified', 'flipped']);
    // Twelve files at least (three stores and their ledger, secret-locations and sniffer files); SQLite's own `-wal` and `-shm` come on top where it leaves them.
    expect(labels.length).toBeGreaterThanOrEqual(16);
  });

  test.each(['dropbox.files', 'x.bookmarks', 'local.files'])('%s: killed after each step, the next boot ends with every file in its folder exactly once', (sourceId) => {
    const labels = labelsOf(sourceId);
    for (const label of labels) {
      const { env, root } = fixture();
      const legacy = install(env, sourceId, { walOn: 'all' });
      const before = new Map(contentFiles(legacy).map((path) => [path, inode(path)]));
      const folded = foldedDigests(legacy);
      onCheckpoint((at) => {
        if (at === label) throw new AccountMigrationKilled(at);
      });
      expect(() => migrateAccountFolders(env), label).toThrow(AccountMigrationKilled);
      __accountMigrationTestHooks.reset();

      // While the move is part way the account is closed, whichever file is where. Killed right after the fold no plan is
      // written yet: nothing has moved, and the account is open and waits for a boot that starts moves.
      const entry = entryOf(env, sourceId)!;
      const planned = label !== 'folded' && label !== 'flipped';
      if (planned) {
        expect(sourceAccountMovePending(entry), label).toBe(true);
        expect(entry.layout, label).toBe('legacy');
        expect(readSourceRegistry(env).schema, label).toBe(3);
        expect(isSourceAccountOpenable({ sourceId }, env), label).toBe(false);
        expect(sourceAccountUnavailableReason({ sourceId }, env), label).toContain('being moved');
      } else if (label === 'folded') {
        expect(sourceAccountMovePending(entry), label).toBe(false);
        expect(isSourceAccountOpenable({ sourceId }, env), label).toBe(true);
      }

      // A fresh boot finishes it: with the switch off when a plan is waiting (it ends whatever the switch says), on when none is.
      const boot = migrateAccountFolders(planned ? withoutSwitch(env) : env);
      expect(boot.errors, label).toEqual([]);
      expect(boot.stuck, label).toEqual([]);
      expect(boot.resumed, label).toEqual(planned ? [sourceId] : []);
      expect(boot.moved, label).toEqual(label === 'flipped' ? [] : [sourceId]);
      for (const path of legacy) expect(existsSync(path), `${label}: ${path} is still at its old place`).toBe(false);
      for (const [path, was] of before) expect(inode(destinationOf(env, path, sourceId)), `${label}: ${path}`).toBe(was);
      expectBytesKept(env, sourceId, folded, 'folder', label);
      expectDatabasesOpen(env, sourceId, legacy, 'folder', label);
      const done = entryOf(env, sourceId)!;
      expect(done.layout, label).toBe('folder');
      expect(done.migration?.state, label).toBe('done');
      expect(readSourceRegistry(env).schema, label).toBe(2);
      // Exactly once: nothing but the moved files is in the account's folder, and nothing else of the account is left in the data root.
      const inFolder = Object.keys(tree(accountFolder({ source_id: sourceId, slot: '1' }, env))).filter((name) => !/-(wal|shm)$/.test(name) && !name.includes('.lock'));
      const expected = legacy.filter((path) => !/-(wal|shm)$/.test(path)).map((path) => relative(accountFolder({ source_id: sourceId, slot: '1' }, env), destinationOf(env, path, sourceId)));
      for (const name of expected) expect(inFolder, `${label}: ${name}`).toContain(name);
      expect(readdirSync(root).filter((name) => /connector-store|local-files-watch|reconcile|archive-import/.test(name)), label).toEqual([]);
    }
  }, 120_000);

  test.each(['dropbox.files', 'x.bookmarks', 'local.files'])('%s: killed after each step and then found wrong, everything goes back exactly as it was once the logs were folded in', (sourceId) => {
    const labels = labelsOf(sourceId).filter((label) => label !== 'flipped');
    for (const label of labels) {
      const { env, root } = fixture();
      const legacy = install(env, sourceId, { walOn: 'all' });
      const before = new Map(contentFiles(legacy).map((path) => [path, inode(path)]));
      const folded = foldedDigests(legacy);
      onCheckpoint((at) => {
        if (at === label) throw new AccountMigrationKilled(at);
      });
      expect(() => migrateAccountFolders(env), label).toThrow(AccountMigrationKilled);
      __accountMigrationTestHooks.reset();
      // The next boot finds the move wrong at the identity check.
      lieAboutSizes(env, sourceId);

      const boot = migrateAccountFolders(label === 'folded' ? env : withoutSwitch(env));

      expect(boot.stuck, label).toEqual([]);
      expect(boot.errors, label).toEqual([]);
      expect(boot.movedBack, label).toEqual([{ sourceId, reason: 'verify_failed' }]);
      for (const [path, was] of before) expect(inode(path), `${label}: ${path}`).toBe(was);
      expectBytesKept(env, sourceId, folded, 'legacy', label);
      expectDatabasesOpen(env, sourceId, legacy, 'legacy', label);
      expect(existsSync(join(root, 'sources', sourceId)), label).toBe(false);
      const done = entryOf(env, sourceId)!;
      expect(done.layout, label).toBe('legacy');
      expect(done.migration?.state, label).toBe('failed');
      expect(isSourceAccountOpenable({ sourceId }, env), label).toBe(true);
    }
  }, 120_000);
});

// The data folder depends on the machine: a standalone Linux engine's receipt names it (and, with no receipt
// yet, it is worked out from what is on disk), OpenClaw-hosted and Mac use `<XDG data home>/openclaw/olympus`.
// The pass must move into whichever it is and leave it the same folder afterwards, so these run on the platform
// they are about (the golden fixture pins the same cases for the resolvers). The first block selects the
// standalone folder by `OLYMPUS_STANDALONE`; the second goes through a real install receipt.
describe.skipIf(process.platform !== 'linux')('on Linux, in each data folder', () => {
  const home = (env: Env): string => env.HOME!;
  const layouts: Array<{ name: string; extra: (dir: string) => Env; root: (env: Env) => string; seed?: (env: Env) => void }> = [
    { name: 'OLYMPUS_STANDALONE, a new data folder', extra: () => ({ OLYMPUS_STANDALONE: '1' }), root: (env) => join(home(env), '.local', 'share', 'olympus') },
    {
      name: 'OLYMPUS_STANDALONE, an existing data folder under openclaw/',
      extra: () => ({ OLYMPUS_STANDALONE: '1' }),
      root: (env) => join(home(env), '.local', 'share', 'openclaw', 'olympus'),
      seed: (env) => {
        mkdirSync(join(home(env), '.local', 'share', 'openclaw', 'olympus'), { recursive: true });
        writeFileSync(join(home(env), '.local', 'share', 'openclaw', 'olympus', 'earlier-install.txt'), 'data from before');
      },
    },
    { name: 'OLYMPUS_STANDALONE with its own XDG data home', extra: (dir) => ({ OLYMPUS_STANDALONE: '1', XDG_DATA_HOME: join(dir, 'xdg') }), root: (env) => join(env.XDG_DATA_HOME!, 'olympus') },
    { name: 'OpenClaw-hosted', extra: (dir) => ({ OPENCLAW_STATE_DIR: join(dir, 'openclaw-state') }), root: (env) => join(home(env), '.local', 'share', 'openclaw', 'olympus') },
  ];

  test.each(layouts.map((layout) => [layout.name, layout] as const))('%s: accounts move inside the data folder, which stays the same folder, and its neighbors are untouched', (_name, layout) => {
    const { dir, env } = fixture();
    Object.assign(env, layout.extra(dir));
    layout.seed?.(env);
    const root = olympusDataRoot(env);
    expect(root).toBe(layout.root(env));
    for (const sourceId of ['gmail.email', 'dropbox.files', 'local.files']) install(env, sourceId);
    // What else a standalone data folder holds: the engine's own folder and the capture folders of step 4d.
    const neighbors = ['engine/engine.json', 'whatsapp-live/session.json', 'telegram/spool.json'].map((name) => join(root, name));
    for (const path of neighbors) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `bytes of ${basename(path)}`);
    }
    const neighborsBefore = neighbors.map(identity);

    const report = migrateAccountFolders(env);

    expect(report.moved.sort(), JSON.stringify(report)).toEqual(['dropbox.files', 'gmail.email', 'local.files']);
    // Still the same folder: worked out from the receipt or the disk, it does not shift because `sources/` now exists.
    expect(olympusDataRoot(env)).toBe(root);
    for (const sourceId of ['gmail.email', 'dropbox.files', 'local.files']) {
      expect(accountFolder({ source_id: sourceId, slot: '1' }, env)).toBe(join(root, 'sources', sourceId, '1'));
      expect(existsSync(join(root, 'sources', sourceId, '1', 'stores')), sourceId).toBe(true);
    }
    expect(sourceRegistryPath(env)).toBe(join(root, 'registry.json'));
    expect(readdirSync(root).filter((name) => /connector-store|local-files-watch/.test(name))).toEqual([]);
    expect(neighbors.map(identity)).toEqual(neighborsBefore);
    expect(migrateAccountFolders(env)).toEqual({ moved: [], resumed: [], movedBack: [], skipped: [], stuck: [], deferred: [], errors: [] });
  });
});

describe.skipIf(process.platform !== 'linux')('on Linux, through a real install receipt', () => {
  /**
   * An environment whose data folder is named by a receipt the install code itself wrote: no `OLYMPUS_STANDALONE`,
   * and nothing on disk yet for the resolver to go by. `legacyFolder` is a receipt of an older install, which names
   * the folder under `openclaw/`.
   */
  function installed(legacyFolder: boolean): { dir: string; env: Env; dataDir: string; receiptPath: string } {
    const { dir, env } = fixture();
    env.XDG_RUNTIME_DIR = join(dir, 'run');
    mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    expect(env.OLYMPUS_STANDALONE).toBeUndefined();
    const layout = resolveLinuxEngineLayout(env);
    const receipt = publishLinuxEngineReceipt(layout);
    const dataDir = legacyFolder ? join(env.XDG_DATA_HOME!, 'openclaw', 'olympus') : layout.dataDir;
    if (legacyFolder) {
      writeFileSync(layout.receiptPath, JSON.stringify({ ...receipt, layout: { ...layout, dataDir, packageDir: join(env.XDG_DATA_HOME!, 'olympus', 'engine') } }), { mode: 0o600 });
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return { dir, env, dataDir, receiptPath: layout.receiptPath };
  }

  test.each([[false], [true]])('legacy folder %p: the receipt names the data folder, the accounts move inside it, and a shell that drifts changes nothing', (legacyFolder) => {
    const { dir, env, dataDir, receiptPath } = installed(legacyFolder);
    expect(standaloneLinuxDataDir(env)).toBe(dataDir);
    expect(olympusDataRoot(env)).toBe(dataDir);
    for (const sourceId of ['dropbox.files', 'local.files']) install(env, sourceId);
    const receiptBefore = readFileSync(receiptPath, 'utf8');
    // The shell the engine was started from has a different XDG data home: the receipt still decides.
    const drifted = { ...env, XDG_DATA_HOME: join(dir, 'somewhere-else') };
    expect(olympusDataRoot(drifted)).toBe(dataDir);

    const report = migrateAccountFolders(drifted);

    expect(report.moved.sort(), JSON.stringify(report)).toEqual(['dropbox.files', 'local.files']);
    expect(existsSync(join(dataDir, 'sources', 'dropbox.files', '1', 'stores', 'secure_local.sqlite'))).toBe(true);
    expect(existsSync(join(dir, 'somewhere-else'))).toBe(false);
    expect(olympusDataRoot(env)).toBe(dataDir);
    expect(olympusDataRoot(drifted)).toBe(dataDir);
    expect(readFileSync(receiptPath, 'utf8')).toBe(receiptBefore);
    expect(readdirSync(dataDir).filter((name) => /connector-store|local-files-watch/.test(name))).toEqual([]);
    expect(migrateAccountFolders(drifted)).toEqual({ moved: [], resumed: [], movedBack: [], skipped: [], stuck: [], deferred: [], errors: [] });
  });
});

describe('the media cache: a moved store keeps its pictures, and the move does not touch the cache', () => {
  // A sweep that drops every marker whose store is gone and every picture nothing holds, however young.
  const FAR_FUTURE = { maxAgeMs: 0, now: Date.now() + 10 * 24 * 60 * 60_000 };

  interface Picture { path: string; holders: StoreHolder[] }

  /** The holder of a store the way picture search takes it: by the store's identity, from the layout and the registry. */
  function holderOf(env: Env, sourceId: string, store: string): StoreHolder {
    const file = legacyAccountFiles(sourceId, env, archiveImportFamilies()).find((entry) => entry.area === 'store' && entry.legacy === store)!;
    const [family, trustDomain] = file.name.includes('.') ? file.name.split('.') as [string, string] : ['file', file.name];
    const holder = placedStoreHolder({ sourceId }, { dbPath: store, family, trustDomain }, env);
    expect(holder, `${store} has an identity`).toBeDefined();
    return holder!;
  }

  /** One picture per store, and one that two stores hold, all held the way picture search holds them. */
  function holdPictures(env: Env, sourceId: string): Picture[] {
    const cache = mediaCacheDir(env);
    const stores = legacyAccountFiles(sourceId, env, archiveImportFamilies()).filter((file) => file.area === 'store').map((file) => file.legacy);
    const hold = (text: string, held: string[]): Picture => {
      const file = writeMediaCacheFile(cache, new TextEncoder().encode(text), 'image/jpeg');
      const holders = held.map((store) => holderOf(env, sourceId, store));
      for (const holder of holders) expect(retainMediaCacheFile(file.path, file.sha256, holder, cache)).toBe(true);
      releaseMediaCacheFile(file.path, file.sha256, file.stagingHolder);
      return { path: file.path, holders };
    };
    return [
      ...stores.map((store) => hold(`picture of ${basename(store)}`, [store])),
      hold('a picture two stores hold', stores.slice(0, 2)),
    ];
  }

  const markersOf = (picture: Picture): Record<string, string> => Object.fromEntries(
    readdirSync(`${picture.path}.refs`).sort().map((name) => [name, readFileSync(join(`${picture.path}.refs`, name), 'utf8')]),
  );

  /** Everything under the media cache: its pictures and their markers, byte for byte. */
  const cacheOf = (env: Env): Record<string, string> => (existsSync(mediaCacheDir(env)) ? tree(mediaCacheDir(env)) : {});

  /** The sweep another store's write would run, here at its harshest: nothing may be dropped, because every store is still there. */
  const sweepDrops = (env: Env): number => sweepMediaCache(mediaCacheDir(env), { ...FAR_FUTURE, env });

  function expectHeld(env: Env, pictures: Picture[], markers: Array<Record<string, string>>, label: string): void {
    expect(sweepDrops(env), `${label}: the sweep dropped a picture`).toBe(0);
    for (const [index, picture] of pictures.entries()) {
      expect(existsSync(picture.path), `${label}: ${picture.path}`).toBe(true);
      // Held once per store that held it, by the same markers: the move wrote none and removed none.
      expect(markersOf(picture), label).toEqual(markers[index]!);
      expect(Object.keys(markersOf(picture)), label).toHaveLength(picture.holders.length);
    }
  }

  test('local files: after the move every picture is held by its store, a sweep drops none, and the cache is byte for byte as it was', () => {
    const { env } = fixture();
    install(env, 'local.files');
    const pictures = holdPictures(env, 'local.files');
    const markers = pictures.map(markersOf);
    const cache = cacheOf(env);
    expect(Object.keys(cache).length).toBeGreaterThan(pictures.length);

    expect(migrateAccountFolders(env).moved).toEqual(['local.files']);

    expect(cacheOf(env)).toEqual(cache);
    expectHeld(env, pictures, markers, 'moved');
  });

  test.each(['dropbox.files', 'local.files'])('%s: a sweep before the first file moves, between any two steps and after the last drops no picture', (sourceId) => {
    const { env } = fixture();
    install(env, sourceId, { walOn: 'all' });
    const pictures = holdPictures(env, sourceId);
    const markers = pictures.map(markersOf);
    const cache = cacheOf(env);
    const steps: string[] = [];
    const dropped: string[] = [];
    onCheckpoint((at) => {
      steps.push(at);
      if (sweepDrops(env) !== 0) dropped.push(at);
    });

    expect(migrateAccountFolders(env).moved).toEqual([sourceId]);

    expect(dropped, 'the sweeps that dropped a picture').toEqual([]);
    expect(steps.filter((at) => at.startsWith('rename:')).length).toBeGreaterThan(5);
    expect(cacheOf(env)).toEqual(cache);
    expectHeld(env, pictures, markers, 'moved');
  });

  test('killed at every step and finished by the next boot, or found wrong and put back, no picture is dropped and no marker changes', () => {
    const labels: string[] = [];
    {
      const { env } = fixture();
      install(env, 'dropbox.files', { walOn: 'all' });
      __accountMigrationTestHooks.checkpoint = (at) => { labels.push(at); };
      migrateAccountFolders(env);
      __accountMigrationTestHooks.reset();
    }
    for (const way of ['finished', 'put back'] as const) {
      for (const label of labels.filter((at) => way === 'finished' || at !== 'flipped')) {
        const { env } = fixture();
        install(env, 'dropbox.files', { walOn: 'all' });
        const pictures = holdPictures(env, 'dropbox.files');
        const markers = pictures.map(markersOf);
        const cache = cacheOf(env);
        const dropped: string[] = [];
        onCheckpoint((at) => {
          if (sweepDrops(env) !== 0) dropped.push(at);
          if (at === label) throw new AccountMigrationKilled(at);
        });
        expect(() => migrateAccountFolders(env), `${way} ${label}`).toThrow(AccountMigrationKilled);
        __accountMigrationTestHooks.reset();
        // A sweep with the move stopped in the middle.
        expectHeld(env, pictures, markers, `${way} ${label}: killed`);

        if (way === 'put back') lieAboutSizes(env, 'dropbox.files');
        const boot = migrateAccountFolders(label === 'folded' ? env : withoutSwitch(env));

        expect(boot.errors, `${way} ${label}`).toEqual([]);
        expect(dropped, `${way} ${label}: the sweeps that dropped a picture`).toEqual([]);
        expect(cacheOf(env), `${way} ${label}`).toEqual(cache);
        expectHeld(env, pictures, markers, `${way} ${label}: after`);
      }
    }
  }, 240_000);

  test('a move that is put back leaves the pictures held exactly as they were', () => {
    const { env } = fixture();
    install(env, 'dropbox.files');
    const pictures = holdPictures(env, 'dropbox.files');
    const markers = pictures.map(markersOf);
    const cache = cacheOf(env);
    lieAboutSizes(env, 'dropbox.files');
    const dropped: string[] = [];
    onCheckpoint((at) => {
      if (sweepDrops(env) !== 0) dropped.push(at);
    });

    expect(migrateAccountFolders(env).movedBack).toHaveLength(1);

    expect(dropped, 'the sweeps that dropped a picture').toEqual([]);
    expect(cacheOf(env)).toEqual(cache);
    expectHeld(env, pictures, markers, 'put back');
  });

  test('no picture cache at all: the move needs none, and makes none', () => {
    const { env } = fixture();
    install(env, 'dropbox.files');
    expect(existsSync(mediaCacheDir(env))).toBe(false);

    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);

    expect(existsSync(mediaCacheDir(env))).toBe(false);
  });
});

describe('a check that fails puts everything back', () => {
  /** Makes the destination of one file read as another size, so the identity check fails with nothing changed on disk. */
  function lieAboutOneSize(env: Env, sourceId: string): void {
    const folder = accountFolder({ source_id: sourceId, slot: '1' }, env);
    __accountMigrationTestHooks.look = (path, actual): MigrationLook | undefined => (
      path.startsWith(`${folder}/`) && path.endsWith('.tier-ledger.sqlite') && actual.kind === 'file'
        ? { ...actual, size: actual.size + 1n }
        : undefined
    );
  }

  test('files are back where they were, byte for byte once the logs were folded in; the account stays legacy with a Needs you row; the entry says what failed', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files', { walOn: 'all' });
    let before: Record<string, string> = {};
    onCheckpoint((at) => {
      // The files as the fold leaves them: from here the pass writes nothing to them.
      if (at === 'folded') before = tree(root);
    });
    lieAboutOneSize(env, 'dropbox.files');

    const report = migrateAccountFolders(env);

    expect(report.movedBack).toEqual([{ sourceId: 'dropbox.files', reason: 'verify_failed' }]);
    expect(report.moved).toEqual([]);
    // Everything but the registry is exactly as it was, inodes included, and no folder is left.
    const after = tree(root);
    const { 'registry.json': _registry, ...restAfter } = after;
    const { 'registry.json': _registryBefore, ...restBefore } = before;
    expect(Object.fromEntries(Object.entries(restAfter).filter(([name]) => !name.startsWith('registry.json') && !name.includes('.lock')))).toEqual(
      Object.fromEntries(Object.entries(restBefore).filter(([name]) => !name.startsWith('registry.json') && !name.includes('.lock'))),
    );
    expect(existsSync(join(root, 'sources', 'dropbox.files'))).toBe(false);
    const entry = entryOf(env, 'dropbox.files')!;
    expect(entry.layout).toBe('legacy');
    expect(entry.migration?.state).toBe('failed');
    expect(entry.migration?.reason).toBe('verify_failed');
    expect(entry.migration?.detail).toContain('changed size');
    expect(entry.migration?.moves).toBeUndefined();
    expect(readSourceRegistry(env).schema).toBe(1);
    // The account opens again, at the paths it always had.
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(true);
    expect(sourceStorageNotices(env)).toEqual([{ source_id: 'dropbox.files', kind: 'moved_back' }]);
    // The detail names no folder of the owner's.
    expect(JSON.stringify(entry.migration)).not.toContain(env.HOME!);
  });

  test('a store that read before and does not open after the move is put back, even though its size is the same', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'readwise.library', { walOn: 'none' });
    const store = legacy.find((path) => path.endsWith('readwise-secure-connector-store.sqlite'))!;
    const size = statSync(store).size;
    // After the plan is written and before the rename: the same bytes' length, no longer a database.
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'plan') writeFileSync(store, Buffer.alloc(size, 7));
    };

    const report = migrateAccountFolders(env);

    expect(report, JSON.stringify(report)).toMatchObject({ movedBack: [{ sourceId: 'readwise.library', reason: 'verify_failed' }] });
    expect(existsSync(store)).toBe(true);
    expect(existsSync(join(root, 'sources', 'readwise.library'))).toBe(false);
    expect(entryOf(env, 'readwise.library')!.migration?.detail).toContain('does not open');
  });

  test('a store that was already damaged is moved without blame: its move is checked by identity, not by its own state', () => {
    const { env } = fixture();
    const legacy = install(env, 'readwise.library', { walOn: 'none' });
    const damaged = legacy.find((path) => path.endsWith('readwise-connector-store.tier-sniffer.sqlite'))!;
    writeFileSync(damaged, Buffer.alloc(64, 9));

    const report = migrateAccountFolders(env);

    expect(report.moved).toEqual(['readwise.library']);
    const entry = entryOf(env, 'readwise.library')!;
    expect(entry.migration?.checked).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'sources/readwise.library/1/stores/internal.tier-sniffer.sqlite', result: 'damaged' }),
    ]));
    expect(entry.migration?.checked?.filter((check) => check.result === 'damaged')).toHaveLength(1);
  });

  test('killed at each step of the way back, the next boot finishes putting it back', () => {
    const labelsRun = (): string[] => {
      const { env } = fixture();
      install(env, 'dropbox.files', { walOn: 'all' });
      lieAboutOneSize(env, 'dropbox.files');
      const labels: string[] = [];
      __accountMigrationTestHooks.checkpoint = (at) => { labels.push(at); };
      migrateAccountFolders(env);
      __accountMigrationTestHooks.reset();
      return labels;
    };
    const labels = labelsRun().filter((label) => label === 'revert' || label.startsWith('unrename:') || label === 'reverted');
    expect(labels.length).toBeGreaterThan(10);
    for (const label of labels) {
      const { env, root } = fixture();
      install(env, 'dropbox.files', { walOn: 'all' });
      let before: Record<string, string> = {};
      onCheckpoint((at) => {
        if (at === 'folded') before = tree(root);
      });
      lieAboutOneSize(env, 'dropbox.files');
      onCheckpoint((at) => {
        if (at === label) throw new AccountMigrationKilled(at);
      });
      expect(() => migrateAccountFolders(env), label).toThrow(AccountMigrationKilled);
      __accountMigrationTestHooks.reset();
      if (label !== 'reverted') {
        expect(entryOf(env, 'dropbox.files')!.migration?.state, label).toBe('reverting');
        expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env), label).toBe(false);
      }

      // The next boot is a clean one: the lie was the injected fault, not the disk.
      const boot = migrateAccountFolders(withoutSwitch(env));

      expect(boot.stuck, label).toEqual([]);
      const entry = entryOf(env, 'dropbox.files')!;
      expect(entry.layout, label).toBe('legacy');
      expect(entry.migration?.state, label).toBe('failed');
      expect(entry.migration?.reason, label).toBe('verify_failed');
      const after = tree(root);
      const strip = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([name]) => !name.startsWith('registry.json') && !name.includes('.lock')));
      expect(strip(after), label).toEqual(strip(before));
      expect(existsSync(join(root, 'sources', 'dropbox.files')), label).toBe(false);
    }
  }, 120_000);

  test('a failed account is tried again at the next boot, and the row goes when it works', () => {
    const { env } = fixture();
    install(env, 'dropbox.files');
    lieAboutOneSize(env, 'dropbox.files');
    migrateAccountFolders(env);
    expect(sourceStorageNotices(env)).toHaveLength(1);
    __accountMigrationTestHooks.reset();

    const report = migrateAccountFolders(env);

    expect(report.moved).toEqual(['dropbox.files']);
    expect(sourceStorageNotices(env)).toEqual([]);
    expect(entryOf(env, 'dropbox.files')!.migration?.state).toBe('done');
  });
});

describe('an account stays where it is, and says why', () => {
  const stays = (env: Env, sourceId: string, reason: string, tree0: Record<string, string>, root: string): void => {
    const report = migrateAccountFolders(env);
    expect(report.skipped, JSON.stringify(report)).toEqual([{ sourceId, reason }]);
    expect(report.moved).toEqual([]);
    const strip = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([name]) => !name.startsWith('registry.json') && !name.includes('.lock') && !name.startsWith('sources')));
    expect(strip(tree(root))).toEqual(strip(tree0));
  };

  test('an override names its files (pinned): no entry is made for it', () => {
    const { env, root } = fixture({ OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: '/elsewhere/dropbox.sqlite' });
    seedLegacy(env, 'dropbox.files');
    stays(env, 'dropbox.files', 'pinned', tree(root), root);
    expect(entryOf(env, 'dropbox.files')).toBeUndefined();
  });

  test('a connector-store mount names its files (pinned), and the entry that exists says so', () => {
    const { env, root } = fixture({ OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: JSON.stringify([{ corpusId: 'secure_local.dropbox.files', trustDomain: 'secure_local', dbPath: '/elsewhere/d.sqlite' }]) });
    install(env, 'dropbox.files');
    stays(env, 'dropbox.files', 'pinned', tree(root), root);
    const entry = entryOf(env, 'dropbox.files')!;
    expect(entry.migration).toMatchObject({ state: 'skipped', reason: 'pinned' });
    expect(entry.layout).toBe('legacy');
    // The pin is the owner's own setting: not a Needs you row.
    expect(sourceStorageNotices(env)).toEqual([]);
  });

  test('a file on another device than the folder is a skip, never a copy', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files');
    __accountMigrationTestHooks.look = (path, actual) => (path === legacy[0] && actual.kind === 'file' ? { ...actual, dev: actual.dev + 1n } : undefined);
    stays(env, 'dropbox.files', 'other_device', tree(root), root);
    expect(entryOf(env, 'dropbox.files')!.migration).toMatchObject({ state: 'skipped', reason: 'other_device' });
    expect(existsSync(join(root, 'sources'))).toBe(false);
  });

  const strip = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([name]) => !name.startsWith('registry.json') && !name.includes('.lock')));

  /** A hard link that works until its `n`th call and then fails with `code`, as a file system that cannot make one does. */
  const linkFailsAt = (n: number, code: string): void => {
    let links = 0;
    __accountMigrationTestHooks.link = (from, to) => {
      links += 1;
      if (links === n) throw Object.assign(new Error(`${code}: link not permitted`), { code });
      linkSync(from, to);
    };
  };

  test('a link that fails with EXDEV in the middle puts back what had moved, and is the same skip as a device that differs', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files', { walOn: 'all' });
    let before: Record<string, string> = {};
    onCheckpoint((at) => { if (at === 'folded') before = tree(root); });
    linkFailsAt(5, 'EXDEV');

    const report = migrateAccountFolders(env);

    expect(report.skipped).toEqual([{ sourceId: 'dropbox.files', reason: 'other_device' }]);
    expect(report.movedBack).toEqual([]);
    expect(strip(tree(root))).toEqual(strip(before));
    expect(existsSync(join(root, 'sources', 'dropbox.files'))).toBe(false);
    expect(entryOf(env, 'dropbox.files')!.migration).toMatchObject({ state: 'skipped', reason: 'other_device' });
    expect(entryOf(env, 'dropbox.files')!.layout).toBe('legacy');
  });

  describe.each([['EPERM'], ['ENOTSUP'], ['EOPNOTSUPP'], ['ENOSYS'], ['EMLINK']])('a file system that makes no hard links (%s)', (code) => {
    test.each([[1, 'at the first file'], [5, 'part way']])('failing %s (%s): the account stays legacy, every file is where and as it was, and the reason is recorded', (n) => {
      const { env, root } = fixture();
      const legacy = install(env, 'dropbox.files', { walOn: 'all' });
      const before = new Map(contentFiles(legacy).map((path) => [path, inode(path)]));
      const folded = foldedDigests(legacy);
      linkFailsAt(n, code);

      const report = migrateAccountFolders(env);

      expect(report.skipped, JSON.stringify(report)).toEqual([{ sourceId: 'dropbox.files', reason: 'no_hard_links' }]);
      expect(report.moved).toEqual([]);
      expect(report.movedBack).toEqual([]);
      expect(report.stuck).toEqual([]);
      for (const [path, was] of before) expect(inode(path), path).toBe(was);
      expectBytesKept(env, 'dropbox.files', folded, 'legacy', code);
      expect(existsSync(join(root, 'sources', 'dropbox.files'))).toBe(false);
      const entry = entryOf(env, 'dropbox.files')!;
      expect(entry.layout).toBe('legacy');
      expect(entry.migration).toMatchObject({ state: 'skipped', reason: 'no_hard_links' });
      expect(entry.migration?.moves).toBeUndefined();
      expect(entry.migration?.detail).toContain('hard links');
      expect(JSON.stringify(entry.migration)).not.toContain(env.HOME!);
      // Not a problem the owner can act on with a click: no Needs you row, and the account opens where it always was.
      expect(sourceStorageNotices(env)).toEqual([]);
      expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(true);
      expect(readSourceRegistry(env).schema).toBe(1);
    });
  });

  test('a file system that never makes a link: every boot ends in the same skip, nothing is copied or renamed instead, and nothing is left behind', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    const before = tree(root);
    __accountMigrationTestHooks.link = () => { throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }); };

    for (const boot of [1, 2, 3]) {
      expect(migrateAccountFolders(env).skipped, `boot ${boot}`).toEqual([{ sourceId: 'dropbox.files', reason: 'no_hard_links' }]);
      expect(strip(tree(root)), `boot ${boot}`).toEqual(strip(before));
      for (const path of legacy) expect(existsSync(path), path).toBe(true);
    }
    expect(existsSync(join(root, 'sources'))).toBe(false);
    expect(entryOf(env, 'dropbox.files')).toMatchObject({ layout: 'legacy', migration: { state: 'skipped', reason: 'no_hard_links' } });
  });

  test('the same account moves once the file system makes links: the skip is not remembered', () => {
    const { env } = fixture();
    install(env, 'dropbox.files', { walOn: 'none' });
    linkFailsAt(1, 'EPERM');
    expect(migrateAccountFolders(env).skipped).toEqual([{ sourceId: 'dropbox.files', reason: 'no_hard_links' }]);
    __accountMigrationTestHooks.reset();

    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);

    expect(entryOf(env, 'dropbox.files')).toMatchObject({ layout: 'folder', migration: { state: 'done' } });
  });

  test('both the old file and one in the folder: nothing moves, and the owner is told (a Needs you row, entry made for it)', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files');
    updateSourceRegistry(env, (registry) => { registry.accounts.length = 0; });
    const inFolder = join(accountFolder({ source_id: 'dropbox.files', slot: '1' }, env), 'stores', 'secure_local.sqlite');
    mkdirSync(dirname(inFolder), { recursive: true });
    writeFileSync(inFolder, 'a different file');
    const before = tree(root);
    const report = migrateAccountFolders(env);
    expect(report.skipped).toEqual([{ sourceId: 'dropbox.files', reason: 'destination_exists' }]);
    for (const path of legacy) expect(existsSync(path)).toBe(true);
    expect(readFileSync(inFolder, 'utf8')).toBe('a different file');
    expect(entryOf(env, 'dropbox.files')).toMatchObject({ layout: 'legacy', migration: { state: 'skipped', reason: 'destination_exists' } });
    expect(sourceStorageNotices(env)).toEqual([{ source_id: 'dropbox.files', kind: 'in_the_way' }]);
    const strip = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([name]) => !name.startsWith('registry.json') && !name.includes('.lock')));
    expect(strip(tree(root))).toEqual(strip(before));
  });

  test('a location that cannot be looked at: nothing moves, and the owner is told', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files');
    __accountMigrationTestHooks.look = (path) => (path === legacy[0] ? { kind: 'unreadable' } : undefined);
    const before = tree(root);
    stays(env, 'dropbox.files', 'unreadable', before, root);
    expect(sourceStorageNotices(env)).toEqual([{ source_id: 'dropbox.files', kind: 'unreadable' }]);
  });

  test('a link where a store should be is not followed or moved', () => {
    const { env, root } = fixture();
    const [store] = install(env, 'dropbox.files');
    const target = join(root, 'elsewhere.sqlite');
    sqliteFile(target);
    rmSync(store!);
    symlinkSync(target, store!);
    stays(env, 'dropbox.files', 'unexpected_file', tree(root), root);
    expect(lstatSync(store!).isSymbolicLink()).toBe(true);
  });

  test('stores the registry lists that are nowhere to be seen (an override once put them elsewhere) are not hidden by a move', () => {
    const { env, root } = fixture();
    // Secure and Personal are at the default place; Public is listed but not there.
    const legacy = seedLegacy(env, 'dropbox.files');
    rmSync(legacy.find((path) => path.endsWith('dropbox-files-public-connector-store.sqlite'))!);
    recordLegacy(env, 'dropbox.files', ['secure_local.dropbox.files', 'internal.dropbox.files', 'public_safe.dropbox.files']);
    stays(env, 'dropbox.files', 'files_elsewhere', tree(root), root);
    // And an account that lists stores while none are at the default place.
    const second = fixture();
    recordLegacy(second.env, 'readwise.library', ['secure_local.readwise.library']);
    const report = migrateAccountFolders(second.env);
    expect(report.skipped).toEqual([{ sourceId: 'readwise.library', reason: 'files_elsewhere' }]);
  });

  test('a skip is written once: the next boot finds the same reason and leaves the registry as it is', () => {
    const { env } = fixture({ OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_DB_PATH: '/elsewhere/gmail.sqlite' });
    install(env, 'gmail.email');
    migrateAccountFolders(env);
    const registry = readFileSync(sourceRegistryPath(env), 'utf8');
    migrateAccountFolders(env);
    expect(readFileSync(sourceRegistryPath(env), 'utf8')).toBe(registry);
  });

  test('nothing to move and nothing listed: nothing is recorded and no folder is made', () => {
    const { env, root } = fixture();
    const report = migrateAccountFolders(env);
    expect(report).toEqual({ moved: [], resumed: [], movedBack: [], skipped: [], stuck: [], deferred: [], errors: [] });
    expect(existsSync(root)).toBe(false);
  });

  test('an account being deleted is left alone', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files');
    updateSourceRegistry(env, (registry) => { registry.accounts[0]!.state = 'deleting'; });
    const before = tree(root);
    const report = migrateAccountFolders(env);
    expect(report.moved).toEqual([]);
    expect(tree(root)).toEqual(before);
  });
});

describe('the logs are folded in first, or the account waits', () => {
  const opened: Database[] = [];
  afterEach(() => {
    for (const db of opened.splice(0)) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // No transaction open.
      }
      db.close();
    }
  });

  const skippedAsUnfolded = (report: ReturnType<typeof migrateAccountFolders>, reason = 'log_not_folded'): void => {
    expect(report.skipped, JSON.stringify(report)).toEqual([{ sourceId: 'dropbox.files', reason }]);
    expect(report.moved).toEqual([]);
    expect(report.stuck).toEqual([]);
  };

  test('a store another connection keeps from finishing its checkpoint is not folded: nothing moves, the reason is recorded, and the account moves once the connection ends', () => {
    const { env, root } = fixture();
    const [store] = install(env, 'dropbox.files', { walOn: 'first' });
    const reader = new Database(store!, { readwrite: true });
    opened.push(reader);
    reader.exec('PRAGMA wal_autocheckpoint = 0; BEGIN');
    expect((reader.query('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(3);

    skippedAsUnfolded(migrateAccountFolders(env), 'busy');

    expect(existsSync(join(root, 'sources'))).toBe(false);
    expect(existsSync(store!)).toBe(true);
    const entry = entryOf(env, 'dropbox.files')!;
    expect(entry).toMatchObject({ layout: 'legacy', migration: { state: 'skipped', reason: 'busy' } });
    expect(entry.migration?.moves).toBeUndefined();
    expect(JSON.stringify(entry.migration)).not.toContain(env.HOME!);
    // The logs are folded in when the store is next closed; waiting costs the owner nothing, so there is no Needs you row.
    expect(sourceStorageNotices(env)).toEqual([]);
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(true);
    expect(readSourceRegistry(env).schema).toBe(1);

    reader.exec('ROLLBACK');
    reader.close();
    opened.length = 0;
    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);
    expect(rowsOf(resolvedStorePath('dropbox.files', 'secure_local', env))).toBe(3);
  }, 30_000);

  test('a store written to after its log was folded is not moved with a log that holds new rows: the account waits, and the next boot folds them in', () => {
    const { env, root } = fixture();
    const [store] = install(env, 'dropbox.files', { walOn: 'none' });
    let writer: Database | undefined;
    onCheckpoint((at) => {
      if (at !== 'folded') return;
      // Another process writes between the fold and the plan, and leaves its rows in the log.
      writer = new Database(store!, { readwrite: true });
      opened.push(writer);
      writer.exec('PRAGMA wal_autocheckpoint = 0');
      writer.query('INSERT INTO t VALUES (?)').run('written late');
    });

    skippedAsUnfolded(migrateAccountFolders(env));
    __accountMigrationTestHooks.reset();

    expect(existsSync(join(root, 'sources'))).toBe(false);
    expect(statSync(`${store}-wal`).size, 'the new rows are in the log').toBeGreaterThan(0);
    expect(entryOf(env, 'dropbox.files')).toMatchObject({ layout: 'legacy', migration: { state: 'skipped', reason: 'log_not_folded' } });
    writer!.close();
    opened.length = 0;

    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);
    const moved = resolvedStorePath('dropbox.files', 'secure_local', env);
    expect(existsSync(`${moved}-wal`) ? statSync(`${moved}-wal`).size : 0).toBe(0);
    expect(rowsOf(moved), 'the row written late is in the database file that moved').toBe(4);
  });

  test('looking at a store never merges a log that someone left in it: the database file is what it was when the account is put off', () => {
    const { env } = fixture();
    const [store] = install(env, 'dropbox.files', { walOn: 'none' });
    let mainFile = '';
    onCheckpoint((at) => {
      if (at !== 'folded') return;
      // A writer that crashed after the fold leaves rows in a log beside the store (the checks that follow open the store).
      sqliteFile(store!, { rows: 5, pendingWal: true });
      mainFile = digest(store!);
    });

    skippedAsUnfolded(migrateAccountFolders(env));
    __accountMigrationTestHooks.reset();

    expect(statSync(`${store}-wal`).size, 'the log was not merged by a look').toBeGreaterThan(0);
    expect(digest(store!)).toBe(mainFile);

    // The next boot folds those rows in, as the fold is for, and moves.
    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);
    expect(rowsOf(resolvedStorePath('dropbox.files', 'secure_local', env))).toBe(5);
  });

  test('a file that is not a database but has a log with bytes in it is not moved away from that log', () => {
    const { env, root } = fixture();
    const [store] = install(env, 'dropbox.files', { walOn: 'none' });
    writeFileSync(store!, Buffer.alloc(64, 9));
    writeFileSync(`${store}-wal`, Buffer.alloc(100, 1));

    skippedAsUnfolded(migrateAccountFolders(env));

    expect(existsSync(join(root, 'sources'))).toBe(false);
    expect(existsSync(store!)).toBe(true);
    expect(entryOf(env, 'dropbox.files')).toMatchObject({ layout: 'legacy', migration: { state: 'skipped', reason: 'log_not_folded' } });
  });
});

describe('the registry cannot be read', () => {
  test('the pass does nothing, and the boot wrapper carries on as it always did', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files');
    writeFileSync(sourceRegistryPath(env), '{ not json');
    const before = tree(root);
    expect(() => migrateAccountFolders(env)).toThrow(SourceRegistryError);
    expect(tree(root)).toEqual(before);
    const warn: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => { warn.push(String(line)); };
    try {
      expect(migrateAccountFoldersAtBoot(env)).toBeUndefined();
    } finally {
      console.warn = original;
    }
    expect(warn.join('\n')).toContain('[storage] Could not check which accounts to move');
    expect(tree(root)).toEqual(before);
  });
});

describe('the time budget', () => {
  test('past it, the accounts not started wait for the next boot, which does them', () => {
    const { env } = fixture();
    for (const sourceId of ['gmail.email', 'dropbox.files', 'readwise.library']) install(env, sourceId);
    let clock = 1_000_000;
    __accountMigrationTestHooks.now = () => clock;
    // The first account takes a minute and a half by the clock.
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'flipped') clock += MIGRATION_BUDGET_MS + 30_000;
    };

    const first = migrateAccountFolders(env);

    expect(first.moved).toEqual(['gmail.email']);
    expect(first.deferred).toEqual(['google_drive.docs', 'dropbox.files', 'local.files', 'readwise.library', 'x.bookmarks', 'archive.imports']);
    expect(entryOf(env, 'dropbox.files')!.layout).toBe('legacy');

    __accountMigrationTestHooks.reset();
    const second = migrateAccountFolders(env);
    expect(second.moved.sort()).toEqual(['dropbox.files', 'readwise.library']);
    expect(second.deferred).toEqual([]);
    expect(entryOf(env, 'dropbox.files')!.layout).toBe('folder');
  });

  test('quick_check only records: past its budget a database is not checked, and the move goes on', () => {
    const { env } = fixture();
    install(env, 'readwise.library', { walOn: 'none' });
    __accountMigrationTestHooks.quickCheckBudgetMs = 0;
    const report = migrateAccountFolders(env);
    expect(report.moved).toEqual(['readwise.library']);
    const checked = entryOf(env, 'readwise.library')!.migration!.checked!;
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.every((check) => check.result === 'not_checked')).toBe(true);
  });

  test('with time, every database is checked before the move and reads ok', () => {
    const { env } = fixture();
    install(env, 'readwise.library', { walOn: 'none' });
    migrateAccountFolders(env);
    const checked = entryOf(env, 'readwise.library')!.migration!.checked!;
    expect(checked.every((check) => check.result === 'ok')).toBe(true);
  });
});

describe('a plan the registry holds', () => {
  const pending = (env: Env, sourceId: string): SourceRegistryAccount => entryOf(env, sourceId)!;

  function killedAfterPlan(sourceId = 'dropbox.files'): { env: Env; root: string; legacy: string[] } {
    const { env, root } = fixture();
    const legacy = install(env, sourceId);
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'plan') throw new AccountMigrationKilled(at);
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    return { env, root, legacy };
  }

  test('names paths relative to the data folder and nothing of the owner\'s home', () => {
    const { env } = killedAfterPlan();
    const entry = pending(env, 'dropbox.files');
    expect(entry.migration?.state).toBe('moving');
    expect(entry.migration!.moves!.length).toBeGreaterThan(8);
    for (const move of entry.migration!.moves!) {
      expect(move.from.startsWith('/') || move.from.includes('..')).toBe(false);
      expect(move.to.startsWith('sources/dropbox.files/1/')).toBe(true);
    }
    expect(readFileSync(sourceRegistryPath(env), 'utf8')).not.toContain(env.HOME!);
  });

  test('a plan this build could not have written is not followed: nothing is renamed, the account stays closed', () => {
    const { env, root } = killedAfterPlan();
    updateSourceRegistry(env, (registry) => {
      const move = registry.accounts[0]!.migration!.moves![0]!;
      move.to = '../../../escape.sqlite';
    });
    const before = tree(root);
    const report = migrateAccountFolders(env);
    expect(report.stuck).toHaveLength(1);
    expect(report.moved).toEqual([]);
    expect(tree(root)).toEqual(before);
    expect(sourceAccountMovePending(pending(env, 'dropbox.files'))).toBe(true);
    expect(existsSync(join(root, '..', 'escape.sqlite'))).toBe(false);
  });

  test('a plan for a source this step does not move (a messaging account) is not followed either', () => {
    const { env, root } = fixture();
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push({
        source_id: 'telegram.messages',
        slot: '1',
        state: 'active',
        layout: 'legacy',
        corpus_ids: [],
        created_at: '2026-10-01T00:00:00.000Z',
        migration: { state: 'moving', at: '2026-10-24T00:00:00.000Z', moves: [] },
      });
    });
    const before = tree(root);
    const report = migrateAccountFolders(env);
    expect(report.stuck).toHaveLength(1);
    expect(tree(root)).toEqual(before);
  });

  test('a file in both places stops the move where it is, and nothing is overwritten', () => {
    const { env, legacy } = killedAfterPlan();
    // A rename got as far as one file; something then wrote another at its old place.
    const source = legacy[0]!;
    const destination = destinationOf(env, source, 'dropbox.files');
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
    writeFileSync(source, 'newer bytes at the old place');
    const destinationBytes = readFileSync(destination);

    const report = migrateAccountFolders(env);

    expect(report.stuck).toHaveLength(1);
    expect(report.moved).toEqual([]);
    expect(readFileSync(destination).equals(destinationBytes)).toBe(true);
    expect(readFileSync(source, 'utf8')).toBe('newer bytes at the old place');
    // Still closed, and on the way back: the next boot is where someone looks.
    expect(sourceAccountMovePending(pending(env, 'dropbox.files'))).toBe(true);
    expect(sourceStorageNotices(env)).toEqual([{ source_id: 'dropbox.files', kind: 'stuck' }]);
  });
});

describe('a file lost while the move is part way', () => {
  /** A move killed after its tenth rename, with the fourth file of its plan then lost from the folder. */
  function loseOneFile(env: Env, root: string, legacy: string[]): { lost: string; others: string[] } {
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'rename:9') throw new AccountMigrationKilled(at);
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    const lostMove = entryOf(env, 'dropbox.files')!.migration!.moves![3]!;
    expect(lostMove.kind).toBe('file');
    rmSync(join(root, ...lostMove.to.split('/')));
    return { lost: lostMove.from, others: legacy.filter((path) => relative(root, path) !== lostMove.from) };
  }

  test('what is there goes back, and the account stays closed with its plan, said in a Needs you row (it is not reopened as if nothing were missing)', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    const { lost, others } = loseOneFile(env, root, legacy);

    const report = migrateAccountFolders(env);

    expect(report.movedBack).toEqual([]);
    expect(report.stuck).toEqual([{ sourceId: 'dropbox.files', detail: expect.stringContaining('neither place') }]);
    for (const path of others) expect(existsSync(path), path).toBe(true);
    expect(existsSync(join(root, lost))).toBe(false);
    const entry = entryOf(env, 'dropbox.files')!;
    expect(entry.migration?.state).toBe('reverting');
    expect(entry.migration?.moves?.length).toBeGreaterThan(3);
    expect(sourceAccountMovePending(entry)).toBe(true);
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(false);
    expect(sourceStorageNotices(env)).toEqual([{ source_id: 'dropbox.files', kind: 'stuck' }]);

    // Every later boot says the same, and moves nothing more.
    const before = tree(root);
    expect(migrateAccountFolders(env).stuck).toHaveLength(1);
    expect(tree(root)).toEqual(before);
    expect(entryOf(env, 'dropbox.files')!.migration?.state).toBe('reverting');
  });

  test('the file found again at its old place lets the roll-back finish: the plan clears only then', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    const { lost, others } = loseOneFile(env, root, legacy);
    expect(migrateAccountFolders(env).stuck).toHaveLength(1);

    // The owner puts a copy back where it always was (a restored file is a new file, not the one the plan saw).
    mkdirSync(dirname(join(root, lost)), { recursive: true });
    sqliteFile(join(root, lost), { rows: 1 });
    const report = migrateAccountFolders(env);

    expect(report.stuck).toEqual([]);
    expect(report.movedBack).toEqual([{ sourceId: 'dropbox.files', reason: 'move_failed' }]);
    for (const path of [...others, join(root, lost)]) expect(existsSync(path), path).toBe(true);
    expect(existsSync(join(root, 'sources'))).toBe(false);
    const entry = entryOf(env, 'dropbox.files')!;
    expect(entry.layout).toBe('legacy');
    expect(entry.migration?.state).toBe('failed');
    expect(sourceStorageNotices(env)).toEqual([{ source_id: 'dropbox.files', kind: 'moved_back' }]);
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(true);
  });

  /** The plan of a dropbox account killed at `label`, and the legacy path of one of its files. */
  function killedAt(label: string, options: Parameters<typeof install>[2] = {}) {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files', options);
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === label) throw new AccountMigrationKilled(at);
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    return { env, root, legacy, moves: entryOf(env, 'dropbox.files')!.migration!.moves! };
  }

  /**
   * A log of the store added to the plan, as a plan made where SQLite leaves a closed database's `-wal` and `-shm` beside
   * it (macOS) carries them: the file is made at its old place and listed with its identity. This build plans only empty
   * logs (the fold empties them and the pass skips an account whose log has bytes again), but a plan is read as data:
   * one that says a log held bytes is believed, and that log's loss is a loss.
   */
  function withPlannedLog(env: Env, root: string, suffix: '-wal' | '-shm', bytes: number): SourceRegistryMove {
    const store = entryOf(env, 'dropbox.files')!.migration!.moves!.find((move) => move.role === 'store' && move.db === true && move.from.endsWith('dropbox-files-connector-store.sqlite'))!;
    const from = `${store.from}${suffix}`;
    const path = join(root, ...from.split('/'));
    writeFileSync(path, Buffer.alloc(bytes, 1));
    const found = lstatSync(path, { bigint: true });
    const move: SourceRegistryMove = { role: 'store', from, to: `${store.to}${suffix}`, kind: 'file', dev: String(found.dev), ino: String(found.ino), size: bytes };
    updateSourceRegistry(env, (registry) => { registry.accounts[0]!.migration!.moves!.push(move); });
    return move;
  }

  test('a write-ahead log the plan says held data and is gone from both places is a loss, before the move and during it', () => {
    for (const label of ['plan', 'rename:5']) {
      const { env, root } = killedAt(label, { walOn: 'none' });
      const wal = withPlannedLog(env, root, '-wal', 4096);
      for (const place of [wal.from, wal.to]) rmSync(join(root, ...place.split('/')), { force: true });

      const report = migrateAccountFolders(env);

      expect(report.moved, label).toEqual([]);
      expect(report.stuck, label).toEqual([{ sourceId: 'dropbox.files', detail: expect.stringContaining('-wal') }]);
      expect(entryOf(env, 'dropbox.files')!.layout, label).toBe('legacy');
      expect(sourceAccountMovePending(entryOf(env, 'dropbox.files')!), label).toBe(true);
      expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env), label).toBe(false);
    }
  });

  test('a log the plan says held data that disappears after the move, before the check, fails the check', () => {
    const { env, root } = killedAt('plan', { walOn: 'none' });
    const wal = withPlannedLog(env, root, '-wal', 4096);
    const last = entryOf(env, 'dropbox.files')!.migration!.moves!.length - 1;
    __accountMigrationTestHooks.checkpoint = (at) => {
      // After every rename and before the identity check: the log at its new place is removed.
      if (at === `rename:${last}`) rmSync(join(root, ...wal.to.split('/')), { force: true });
    };

    const report = migrateAccountFolders(env);

    expect(report.moved).toEqual([]);
    expect(report.stuck).toHaveLength(1);
    expect(entryOf(env, 'dropbox.files')!.migration?.state).toBe('reverting');
  });

  test('only SQLite\'s scratch files may be missing, the index (-shm) and a log that held nothing: without them the move goes through', () => {
    const { env, root } = killedAt('plan', { walOn: 'none' });
    const scratch = [withPlannedLog(env, root, '-shm', 32), withPlannedLog(env, root, '-wal', 0)];
    for (const move of scratch) rmSync(join(root, ...move.from.split('/')), { force: true });

    const report = migrateAccountFolders(env);

    expect(report.moved).toEqual(['dropbox.files']);
    expect(entryOf(env, 'dropbox.files')!.layout).toBe('folder');
    expect(storeFileReads(resolvedStorePath('dropbox.files', 'secure_local', env))).toBe('reads');
  });
});

describe('every file of a plan lost, with no Delete: that is a loss, not a Delete', () => {
  /** A plan written and nothing moved yet (killed at `plan`), then every file it names removed from both places. */
  function loseEverything(env: Env, root: string, onlyTheStore: boolean): SourceRegistryMove[] {
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'plan') throw new AccountMigrationKilled(at);
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    if (onlyTheStore) {
      // The account with one database in its plan: the plan is read as data, and this one names the store alone.
      updateSourceRegistry(env, (registry) => {
        const migration = registry.accounts[0]!.migration!;
        migration.moves = migration.moves!.filter((move) => move.role === 'store' && move.db === true && !isCompanionPath(move.from)).slice(0, 1);
      });
    }
    const moves = entryOf(env, 'dropbox.files')!.migration!.moves!;
    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) {
      for (const place of [move.from, move.to]) rmSync(join(root, ...place.split('/')), { recursive: true, force: true });
    }
    return moves;
  }

  test('the one database of a plan gone: the account stays closed with its plan, and the owner is told', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files', { walOn: 'none' });
    const moves = loseEverything(env, root, true);
    expect(moves).toHaveLength(1);

    const report = migrateAccountFolders(env);

    expect(report.stuck, JSON.stringify(report)).toEqual([{ sourceId: 'dropbox.files', detail: expect.stringContaining('neither place') }]);
    expect(report.moved).toEqual([]);
    const entry = entryOf(env, 'dropbox.files')!;
    expect(sourceAccountMovePending(entry)).toBe(true);
    expect(entry.migration?.moves).toHaveLength(moves.length);
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(false);
    expect(sourceStorageNotices(env)).toEqual([{ source_id: 'dropbox.files', kind: 'stuck' }]);
    // And so on at every boot: nothing is made in its place.
    expect(migrateAccountFolders(env).stuck).toHaveLength(1);
    for (const place of [moves[0]!.from, moves[0]!.to]) expect(existsSync(join(root, ...place.split('/'))), place).toBe(false);
  });

  test('every file of a whole plan gone from both places is the same: closed, with the row', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files', { walOn: 'none' });
    const moves = loseEverything(env, root, false);
    expect(moves.length).toBeGreaterThan(4);

    const report = migrateAccountFolders(env);

    expect(report.stuck).toEqual([{ sourceId: 'dropbox.files', detail: expect.stringContaining('neither place') }]);
    expect(sourceAccountMovePending(entryOf(env, 'dropbox.files')!)).toBe(true);
    expect(sourceStorageNotices(env)).toEqual([{ source_id: 'dropbox.files', kind: 'stuck' }]);
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(false);
  });

  test('a Delete is what ends it: the owner deletes the account, and the plan goes with its files', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files', { walOn: 'none' });
    loseEverything(env, root, true);
    expect(migrateAccountFolders(env).stuck).toHaveLength(1);

    deleteOlympusData({ sourceId: 'dropbox.files', homeDir: env.HOME!, env });

    // The entry goes with the files and the plan (step 5): nothing is left to report.
    expect(entryOf(env, 'dropbox.files')).toBeUndefined();
    expect(sourceStorageNotices(env)).toEqual([]);
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(true);
    expect(migrateAccountFolders(env)).toMatchObject({ moved: [], stuck: [], movedBack: [], errors: [] });
  });
});

describe('Delete, with the move', () => {
  const without = (all: Record<string, string>, ...prefixes: string[]): Record<string, string> => Object.fromEntries(
    Object.entries(all).filter(([name]) => !name.startsWith('registry.json') && !name.includes('.lock') && !prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}/`))),
  );

  test('an account moved by the pass is deleted as its folder, and nothing beside it goes', () => {
    const { env, root } = fixture();
    for (const sourceId of ['readwise.library', 'x.bookmarks', 'dropbox.files']) install(env, sourceId);
    const bystanders = ['x-bookmarks-api-usage.sqlite', 'file-source-scopes.json'].map((name) => join(root, name));
    for (const path of bystanders) writeFileSync(path, `bytes of ${basename(path)}`);
    expect(migrateAccountFolders(env).moved).toEqual(expect.arrayContaining(['readwise.library', 'x.bookmarks', 'dropbox.files']));
    const folder = accountFolder({ source_id: 'readwise.library', slot: '1' }, env);
    // Each history names its provider account (storage step 4e).
    updateSourceRegistry(env, (registry) => {
      for (const account of registry.accounts) account.provider_account_hash = `${account.source_id}:owner`;
    });
    const before = tree(root);
    expect(Object.keys(without(before)).filter((name) => name.startsWith('sources/readwise.library/1/')).length).toBeGreaterThan(8);

    const result = deleteOlympusData({ sourceId: 'readwise.library', homeDir: env.HOME!, env });

    // The deleted account's entry went with it, so another account may connect; the others keep theirs.
    expect(entryOf(env, 'readwise.library')).toBeUndefined();
    expect(entryOf(env, 'dropbox.files')!.provider_account_hash).toBe('dropbox.files:owner');
    expect(result.removed).toContain(folder);
    expect(existsSync(folder)).toBe(false);
    // Exactly its folder: every other file, the other accounts' and the shared ones, is where it was, byte for byte.
    expect(without(tree(root), 'sources/readwise.library')).toEqual(without(before, 'sources/readwise.library'));
    // And no file of it is left at its old place either.
    expect(readdirSync(root).filter((name) => name.startsWith('readwise'))).toEqual([]);
  });

  test('a Delete while the move is part way takes the files wherever they are, and drops the plan itself: the next boot finds nothing to say', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files');
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'rename:7') throw new AccountMigrationKilled(at);
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    expect(existsSync(join(root, 'sources', 'dropbox.files', '1'))).toBe(true);
    expect(readdirSync(root).some((name) => name.startsWith('dropbox'))).toBe(true);

    deleteOlympusData({ sourceId: 'dropbox.files', homeDir: env.HOME!, env });

    expect(readdirSync(root).filter((name) => name.startsWith('dropbox'))).toEqual([]);
    expect(existsSync(join(root, 'sources', 'dropbox.files', '1'))).toBe(false);
    // The Delete is the evidence that the files are gone because the owner said so: the plan went with them
    // (with the entry, step 5), before any boot.
    expect(entryOf(env, 'dropbox.files')).toBeUndefined();
    expect(sourceStorageNotices(env)).toEqual([]);
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(true);

    const report = migrateAccountFolders(env);
    expect(report).toMatchObject({ moved: [], resumed: [], movedBack: [], stuck: [], deferred: [], errors: [] });
    expect(entryOf(env, 'dropbox.files')).toBeUndefined();
    expect(sourceStorageNotices(env)).toEqual([]);
    expect(readSourceRegistry(env).schema).toBe(1);
  });

  test('an export while the move is part way is refused and writes nothing; once the move is finished it exports the moved stores', () => {
    const { dir, env, root } = fixture();
    install(env, 'dropbox.files');
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'rename:7') throw new AccountMigrationKilled(at);
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    expect(sourceAccountMovePending(entryOf(env, 'dropbox.files')!)).toBe(true);

    for (const sourceId of ['dropbox.files', undefined]) {
      const output = join(dir, `export-${sourceId ?? 'all'}`);
      expect(() => exportOlympusData({ destination: output, ...(sourceId ? { sourceId } : {}), homeDir: env.HOME!, env }), sourceId ?? 'all').toThrow(/part way through moving/);
      expect(existsSync(output), `${sourceId ?? 'all'}: nothing written`).toBe(false);
    }
    // Another source's export is not held up by it.
    expect(() => exportOlympusData({ destination: join(dir, 'export-readwise'), sourceId: 'readwise.library', homeDir: env.HOME!, env })).not.toThrow();

    expect(migrateAccountFolders(withoutSwitch(env)).resumed).toEqual(['dropbox.files']);
    const finished = exportOlympusData({ destination: join(dir, 'export-after'), sourceId: 'dropbox.files', homeDir: env.HOME!, env });
    expect(finished.files.some((file) => file.includes('dropbox'))).toBe(true);
    expect(readdirSync(root).filter((name) => name.startsWith('dropbox'))).toEqual([]);
  });

  test('an export is refused when the registry cannot be read, since a move cannot be ruled out', () => {
    const { dir, env } = fixture();
    install(env, 'dropbox.files');
    writeFileSync(sourceRegistryPath(env), '{ not json');
    const output = join(dir, 'export');
    expect(() => exportOlympusData({ destination: output, sourceId: 'dropbox.files', homeDir: env.HOME!, env })).toThrow(/nothing was exported/);
    expect(existsSync(output)).toBe(false);
  });

  test('a Delete of another source leaves the plan alone: only the account whose files it took loses its plan', () => {
    const { env } = fixture();
    install(env, 'dropbox.files');
    install(env, 'readwise.library');
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'rename:7') throw new AccountMigrationKilled(at);
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    const pending = readSourceRegistry(env).accounts.filter(sourceAccountMovePending).map((account) => account.source_id);
    expect(pending).toHaveLength(1);
    const other = ['dropbox.files', 'readwise.library'].find((id) => !pending.includes(id))!;

    deleteOlympusData({ sourceId: other, homeDir: env.HOME!, env });

    expect(readSourceRegistry(env).accounts.filter(sourceAccountMovePending).map((account) => account.source_id)).toEqual(pending);
    expect(readSourceRegistry(env).schema).toBe(3);

    deleteOlympusData({ sourceId: pending[0]!, homeDir: env.HOME!, env });

    expect(readSourceRegistry(env).accounts.filter(sourceAccountMovePending)).toEqual([]);
    expect(readSourceRegistry(env).schema).toBe(1);
  });

  test('a Delete that finds nothing pending changes no other entry: only its own goes', () => {
    const { env } = fixture();
    install(env, 'dropbox.files');
    install(env, 'readwise.library');
    const before = readSourceRegistry(env);

    deleteOlympusData({ sourceId: 'dropbox.files', homeDir: env.HOME!, env });

    expect(readSourceRegistry(env)).toEqual({ ...before, accounts: before.accounts.filter((account) => account.source_id !== 'dropbox.files') });
  });
});

describe('while a move is part way, the account is closed', () => {
  test('the storage service refuses it, with the reason in words', () => {
    const { env } = fixture();
    install(env, 'dropbox.files');
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'rename:1') throw new AccountMigrationKilled(at);
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    const open = () => openConnectorStore({ sourceId: 'dropbox.files' }, {
      dbPath: join(olympusDataRoot(env), 'dropbox-files-connector-store.sqlite'),
      corpusId: 'secure_local.dropbox.files',
      family: 'file',
      trustDomain: 'secure_local',
      readOnly: true,
    }, env);
    expect(open).toThrow(SourceStorageUnavailableError);
    try {
      open();
    } catch (error) {
      expect((error as SourceStorageUnavailableError).state).toBe('moving');
      expect((error as Error).message).toBe('dropbox.files is not available: its files are being moved into its folder.');
    }
    // Another account is not affected.
    expect(isSourceAccountOpenable({ sourceId: 'gmail.email' }, env)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review of the first build of the pass (PR #508): each finding's own proof.

describe('a boot before the move ends cannot turn the account into an empty folder', () => {
  /** Files with no registry entry, so the pass makes one that lists no corpus; killed once every file has moved. */
  function killedAfterTheLastRename() {
    const { env, root } = fixture();
    const legacy = seedLegacy(env, 'dropbox.files', { walOn: 'none' });
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'verified') throw new AccountMigrationKilled(at);
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    return { env, root, legacy };
  }

  test('re-placing empty accounts leaves an account with a move under way to the pass', () => {
    const { env, root, legacy } = killedAfterTheLastRename();
    expect(legacy.some((path) => existsSync(path)), 'no file is left at a legacy place').toBe(false);
    const entry = entryOf(env, 'dropbox.files')!;
    expect(entry.corpus_ids).toEqual([]);
    expect(sourceAccountMovePending(entry)).toBe(true);

    expect(replaceEmptyLegacyAccounts(env)).toEqual([]);
    expect(entryOf(env, 'dropbox.files')!.layout).toBe('legacy');

    const report = migrateAccountFolders(withoutSwitch(env));
    expect(report.moved).toEqual(['dropbox.files']);
    expect(entryOf(env, 'dropbox.files')!.layout).toBe('folder');
    expect(existsSync(join(accountFolder({ source_id: 'dropbox.files', slot: '1' }, env), 'stores'))).toBe(true);
    expect(readdirSync(root).filter((name) => name.startsWith('dropbox'))).toEqual([]);
  });

  test('a roll-back always leaves the account legacy, whatever the entry said when it began', () => {
    const { env, root, legacy } = killedAfterTheLastRename();
    // What a re-placement in between used to leave: a folder with its plan still being undone.
    updateSourceRegistry(env, (registry) => {
      const account = registry.accounts.find((entry) => entry.source_id === 'dropbox.files')!;
      account.layout = 'folder';
      account.migration = { ...account.migration!, state: 'reverting', reason: 'verify_failed', detail: 'A check failed.' };
    });

    const report = migrateAccountFolders(env);

    expect(report.movedBack).toEqual([{ sourceId: 'dropbox.files', reason: 'verify_failed' }]);
    const entry = entryOf(env, 'dropbox.files')!;
    expect(entry.layout).toBe('legacy');
    expect(entry.migration?.state).toBe('failed');
    for (const path of legacy.filter((file) => !/-(wal|shm)$/.test(file))) expect(existsSync(path), path).toBe(true);
    expect(existsSync(join(root, 'sources'))).toBe(false);
    expect(resolvedStorePath('dropbox.files', 'secure_local', env)).toBe(legacy[0]!);
  });
});

describe('a file is never moved onto something that is there', () => {
  const lieAboutOneSize = (env: Env): void => {
    const folder = accountFolder({ source_id: 'dropbox.files', slot: '1' }, env);
    __accountMigrationTestHooks.look = (path, actual): MigrationLook | undefined => (
      path.startsWith(`${folder}/`) && path.endsWith('.tier-ledger.sqlite') && actual.kind === 'file'
        ? { ...actual, size: actual.size + 1n }
        : undefined
    );
  };

  test('a file that appears at the destination after the look is left alone, and the move is undone', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    const store = legacy[0]!;
    const target = destinationOf(env, store, 'dropbox.files');
    const original = identity(store);
    let reached = 0;
    __accountMigrationTestHooks.beforeMove = (_from, to) => {
      if (to !== target) return;
      reached += 1;
      writeFileSync(to, 'written by another process');
    };

    const report = migrateAccountFolders(env);

    expect(reached).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('written by another process');
    expect(report.movedBack).toEqual([{ sourceId: 'dropbox.files', reason: 'move_failed' }]);
    expect(identity(store)).toBe(original);
    for (const path of legacy.filter((file) => !/-(wal|shm)$/.test(file))) expect(existsSync(path), path).toBe(true);
    const entry = entryOf(env, 'dropbox.files')!;
    expect(entry.layout).toBe('legacy');
    expect(entry.migration).toMatchObject({ state: 'failed', reason: 'move_failed' });
    expect(entry.migration?.detail).toContain('both places');
    // The stranger's file is all that is left in the folder, and the next boot says why it will not move.
    expect(readdirSync(dirname(target))).toEqual([basename(target)]);
    __accountMigrationTestHooks.reset();
    expect(migrateAccountFolders(env).skipped).toEqual([{ sourceId: 'dropbox.files', reason: 'destination_exists' }]);
    expect(readFileSync(target, 'utf8')).toBe('written by another process');
    expect(root).toBeTruthy();
  });

  test('going back, a file that appears at the old place is left alone and the account stays closed with its plan', () => {
    const { env } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    const store = legacy[0]!;
    const target = destinationOf(env, store, 'dropbox.files');
    lieAboutOneSize(env);
    let reached = 0;
    __accountMigrationTestHooks.beforeMove = (_from, to) => {
      if (to !== store || existsSync(to)) return;
      reached += 1;
      writeFileSync(to, 'written by another process');
    };

    const report = migrateAccountFolders(env);

    expect(reached).toBe(1);
    expect(readFileSync(store, 'utf8')).toBe('written by another process');
    expect(existsSync(target), 'the store that could not go back is still in the folder').toBe(true);
    expect(report.stuck).toEqual([{ sourceId: 'dropbox.files', detail: expect.stringContaining('both places') }]);
    expect(entryOf(env, 'dropbox.files')!.migration?.state).toBe('reverting');
    expect(sourceStorageNotices(env)).toEqual([{ source_id: 'dropbox.files', kind: 'stuck' }]);
  });

  test('killed between the link and the unlink, the file under two names is finished by the next boot', () => {
    const { env } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    const store = legacy[0]!;
    const target = destinationOf(env, store, 'dropbox.files');
    const original = identity(store);
    __accountMigrationTestHooks.link = (from, to) => {
      linkSync(from, to);
      if (to === target) throw new AccountMigrationKilled('between the link and the unlink');
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    expect(identity(target)).toBe(original);
    expect(existsSync(store)).toBe(true);

    const report = migrateAccountFolders(withoutSwitch(env));

    expect(report).toMatchObject({ moved: ['dropbox.files'], resumed: ['dropbox.files'], movedBack: [], stuck: [], errors: [] });
    expect(existsSync(store)).toBe(false);
    expect(identity(target)).toBe(original);
  });

  test('killed between the link and the unlink on the way back, the next boot finishes putting it back', () => {
    const { env } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    const store = legacy[0]!;
    const target = destinationOf(env, store, 'dropbox.files');
    const original = identity(store);
    lieAboutOneSize(env);
    __accountMigrationTestHooks.link = (from, to) => {
      linkSync(from, to);
      if (to === store) throw new AccountMigrationKilled('between the link and the unlink');
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    expect(identity(store)).toBe(original);
    expect(existsSync(target)).toBe(true);

    const report = migrateAccountFolders(withoutSwitch(env));

    expect(report.movedBack).toEqual([{ sourceId: 'dropbox.files', reason: 'verify_failed' }]);
    expect(report.stuck).toEqual([]);
    expect(identity(store)).toBe(original);
    expect(existsSync(target)).toBe(false);
    expect(entryOf(env, 'dropbox.files')!.layout).toBe('legacy');
  });

  test('a log made at the new place after the plan goes back with its store, and a kill between its link and its unlink is finished by the next boot', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    const store = legacy.find((path) => path.endsWith('dropbox-files-connector-store.sqlite'))!;
    const target = destinationOf(env, store, 'dropbox.files');
    // A store with no log at the plan, and one at its new place by the time the move is found wrong: its identity is not in the plan.
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${store}${suffix}`, { force: true });
    lieAboutOneSize(env);
    const scratchAtNewPlace = `${target}-journal`;
    onCheckpoint((at) => {
      if (at.startsWith('rename:') && !existsSync(scratchAtNewPlace) && existsSync(target)) writeFileSync(scratchAtNewPlace, 'made after the plan');
    });
    const original = inode(store);
    const scratchAtOldPlace = `${store}-journal`;
    __accountMigrationTestHooks.link = (from, to) => {
      linkSync(from, to);
      if (to === scratchAtOldPlace) throw new AccountMigrationKilled('between the link and the unlink');
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    expect(existsSync(scratchAtNewPlace) && existsSync(scratchAtOldPlace), 'one file under two names').toBe(true);
    expect(inode(scratchAtNewPlace)).toBe(inode(scratchAtOldPlace));

    const report = migrateAccountFolders(withoutSwitch(env));

    expect(report.stuck, JSON.stringify(report)).toEqual([]);
    expect(report.movedBack).toEqual([{ sourceId: 'dropbox.files', reason: 'verify_failed' }]);
    expect(readFileSync(scratchAtOldPlace, 'utf8')).toBe('made after the plan');
    expect(existsSync(scratchAtNewPlace)).toBe(false);
    expect(inode(store)).toBe(original);
    expect(existsSync(join(root, 'sources', 'dropbox.files'))).toBe(false);
    expect(entryOf(env, 'dropbox.files')).toMatchObject({ layout: 'legacy', migration: { state: 'failed', reason: 'verify_failed' } });
  });

  test('a folder is moved only onto nothing: a non-empty folder that appears is not replaced', () => {
    const { env } = fixture();
    install(env, 'local.files', { walOn: 'none' });
    const folder = accountFolder({ source_id: 'local.files', slot: '1' }, env);
    const watch = join(folder, 'raw', 'watch');
    __accountMigrationTestHooks.beforeMove = (_from, to) => {
      if (to !== watch) return;
      mkdirSync(watch);
      writeFileSync(join(watch, 'theirs.snap'), 'another process');
    };

    const report = migrateAccountFolders(env);

    expect(report.movedBack).toEqual([{ sourceId: 'local.files', reason: 'move_failed' }]);
    expect(readFileSync(join(watch, 'theirs.snap'), 'utf8')).toBe('another process');
    const legacyWatch = legacyAccountFiles('local.files', env, []).find((file) => file.area === 'raw')!.legacy;
    expect(readdirSync(legacyWatch).sort()).toEqual(['a.snap', 'b.snap']);
  });
});

describe('the renames and the new folders are on disk before the registry says so', () => {
  const lieAboutOneSize = (env: Env): void => {
    const folder = accountFolder({ source_id: 'dropbox.files', slot: '1' }, env);
    __accountMigrationTestHooks.look = (path, actual): MigrationLook | undefined => (
      path.startsWith(`${folder}/`) && path.endsWith('.tier-ledger.sqlite') && actual.kind === 'file'
        ? { ...actual, size: actual.size + 1n }
        : undefined
    );
  };

  /** What the pass syncs and the steps it passes, in order, with folders named relative to the data folder. */
  function record(root: string): string[] {
    const real = realpathSync(root);
    const events: string[] = [];
    __accountMigrationTestHooks.syncDirectory = (path) => { events.push(`sync:${relative(real, realpathSync(path)) || '.'}`); };
    __accountMigrationTestHooks.checkpoint = (at) => { events.push(at); };
    return events;
  }
  const syncedBetween = (events: string[], from: number, to: number): string[] =>
    [...new Set(events.slice(from, to).filter((event) => event.startsWith('sync:')).map((event) => event.slice(5)))].sort();
  const indexesOf = (events: string[], prefix: string): number[] =>
    events.flatMap((event, index) => (event === prefix || event.startsWith(prefix) ? [index] : []));

  test('going forward: every new folder is synced before the first rename, both ends of the renames before the first record', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files');
    const events = record(root);

    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);

    const folder = 'sources/dropbox.files/1';
    const renames = indexesOf(events, 'rename:');
    expect(renames.length).toBeGreaterThan(5);
    expect(syncedBetween(events, 0, renames[0]!)).toEqual(['.', 'sources', 'sources/dropbox.files', folder, `${folder}/stores`].sort());
    expect(syncedBetween(events, renames.at(-1)! + 1, events.indexOf('verified'))).toEqual(['.', `${folder}/stores`].sort());
  });

  test('going back: the put-back is synced before the record of it', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files');
    lieAboutOneSize(env);
    const events = record(root);

    expect(migrateAccountFolders(env).movedBack).toHaveLength(1);

    const unrenames = indexesOf(events, 'unrename:');
    expect(unrenames.length).toBeGreaterThan(5);
    expect(syncedBetween(events, unrenames.at(-1)! + 1, events.indexOf('reverted'))).toContain('.');
  });
});

describe('a file always has a name that survives a power failure', () => {
  /**
   * Spies on every fsync of a folder. At each one it records where the pass is (how many moves it has recorded: the
   * `rename:<n>` or `unrename:<n>` steps it passed), the folder, and for every planned file whether it is under both its
   * names right now (`both`: linked, the old name not removed), under its new one only (`new`) or its old one only
   * (`old`). That places a sync in the window of the one file it belongs to, and says whether the old name was still there.
   */
  function spy(env: Env, root: string) {
    type Sync = { done: number; folder: string; afterRevert: boolean; states: Map<string, 'both' | 'new' | 'old' | 'none'> };
    const syncs: Sync[] = [];
    let moves: SourceRegistryMove[] = [];
    let done = 0;
    let afterRevert = false;
    const at = (rel: string): string => join(root, ...rel.split('/'));
    onCheckpoint((point) => {
      if (point === 'plan') moves = entryOf(env, 'dropbox.files')?.migration?.moves ?? entryOf(env, 'local.files')?.migration?.moves ?? [];
      if (point === 'revert') { done = 0; afterRevert = true; }
      else if (point.startsWith('rename:') || point.startsWith('unrename:')) done += 1;
    });
    __accountMigrationTestHooks.syncDirectory = (folder) => {
      const states = new Map<string, 'both' | 'new' | 'old' | 'none'>();
      for (const move of moves) {
        const from = existsSync(at(move.from));
        const to = existsSync(at(move.to));
        states.set(move.to, from && to ? 'both' : to ? 'new' : from ? 'old' : 'none');
      }
      syncs.push({ done, folder, afterRevert, states });
    };
    return { syncs, moves: () => moves, at };
  }

  const lieAboutLocalFilesSizes = (env: Env): void => lieAboutSizes(env, 'local.files');
  const lieAboutLedgerSize = (env: Env): void => {
    const folder = accountFolder({ source_id: 'dropbox.files', slot: '1' }, env);
    __accountMigrationTestHooks.look = (path, actual): MigrationLook | undefined => (
      path.startsWith(`${folder}/`) && path.endsWith('.tier-ledger.sqlite') && actual.kind === 'file'
        ? { ...actual, size: actual.size + 1n }
        : undefined
    );
  };

  test('going forward: each file is linked, the folder holding its new name is synced, and only then is its old name removed', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files');
    const watch = spy(env, root);

    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);

    const moves = watch.moves();
    expect(moves.length).toBeGreaterThan(5);
    moves.forEach((move, index) => {
      const syncedWhileBothNames = watch.syncs.filter((sync) => sync.done === index && sync.folder === dirname(watch.at(move.to)) && sync.states.get(move.to) === 'both');
      expect(syncedWhileBothNames.length, `${move.to}: its folder was not synced between the link and the unlink`).toBeGreaterThan(0);
    });
  });

  test('going back, the same: the folder that gets the old name is synced before the new name is removed', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files');
    lieAboutLedgerSize(env);
    const watch = spy(env, root);

    expect(migrateAccountFolders(env).movedBack).toHaveLength(1);

    const moves = watch.moves();
    expect(moves.length).toBeGreaterThan(5);
    [...moves].reverse().forEach((move, index) => {
      const syncedWhileBothNames = watch.syncs.filter((sync) => sync.done === index && sync.folder === dirname(watch.at(move.from)) && sync.states.get(move.to) === 'both');
      expect(syncedWhileBothNames.length, `${move.from}: its folder was not synced between the link and the unlink`).toBeGreaterThan(0);
    });
  });

  test('a folder moved by rename has both parents synced before the next thing is moved, forward and back', () => {
    for (const direction of ['forward', 'back'] as const) {
      const { env, root } = fixture();
      install(env, 'local.files');
      if (direction === 'back') lieAboutLocalFilesSizes(env);
      const watch = spy(env, root);

      const report = migrateAccountFolders(env);

      expect(direction === 'forward' ? report.moved : report.movedBack.map((entry) => entry.sourceId), direction).toEqual(['local.files']);
      const moves = watch.moves();
      const dirIndex = moves.findIndex((move) => move.kind === 'dir');
      expect(dirIndex, direction).toBeGreaterThanOrEqual(0);
      const dir = moves[dirIndex]!;
      const index = direction === 'forward' ? dirIndex : moves.length - 1 - dirIndex;
      const parents = [dirname(watch.at(dir.to)), dirname(watch.at(dir.from))];
      const state = direction === 'forward' ? 'new' : 'old';
      for (const parent of parents) {
        const synced = watch.syncs.filter((sync) => sync.done === index && sync.folder === parent && sync.states.get(dir.to) === state);
        expect(synced.length, `${direction}: ${parent} was not synced after the folder moved`).toBeGreaterThan(0);
      }
    }
  });

  test('killed between the link and the unlink, the next boot syncs the name that stays before it removes the other', () => {
    for (const direction of ['forward', 'back'] as const) {
      const { env } = fixture();
      const legacy = install(env, 'dropbox.files', { walOn: 'none' });
      const store = legacy[0]!;
      const target = destinationOf(env, store, 'dropbox.files');
      if (direction === 'back') lieAboutLedgerSize(env);
      __accountMigrationTestHooks.link = (from, to) => {
        linkSync(from, to);
        if (to === (direction === 'forward' ? target : store)) throw new AccountMigrationKilled('between the link and the unlink');
      };
      expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
      __accountMigrationTestHooks.reset();
      expect(existsSync(store) && existsSync(target), `${direction}: one file under two names`).toBe(true);

      const stays = direction === 'forward' ? target : store;
      let syncedWhileTwoNames = false;
      __accountMigrationTestHooks.syncDirectory = (folder) => {
        if (folder === dirname(stays) && existsSync(store) && existsSync(target)) syncedWhileTwoNames = true;
      };
      const report = migrateAccountFolders(withoutSwitch(env));

      expect(report.stuck, direction).toEqual([]);
      expect(syncedWhileTwoNames, `${direction}: the folder of the name that stays was not synced before the other name went`).toBe(true);
      expect(existsSync(direction === 'forward' ? store : target), direction).toBe(false);
    }
  });

  /** The folders from the data root down to the stores folder of the Dropbox account. */
  const chainOf = (root: string): string[] => {
    const folder = join(root, 'sources', 'dropbox.files', '1');
    return [root, join(root, 'sources'), join(root, 'sources', 'dropbox.files'), folder, join(folder, 'stores')];
  };

  test('a run that died after making its folders and before syncing them: the next boot syncs every folder from the data root down before it removes the first old name', () => {
    for (const variant of ['the first run was killed at its first sync', 'part of the chain was there already']) {
      const { env, root } = fixture();
      install(env, 'dropbox.files', { walOn: 'none' });
      if (variant.startsWith('the first run')) {
        // The folders are made, and the worker dies before anything about them is on disk.
        __accountMigrationTestHooks.syncDirectory = () => { throw new AccountMigrationKilled('after the folders were made, before any sync'); };
      } else {
        // The worker died with the plan written and only the first folder made.
        __accountMigrationTestHooks.checkpoint = (at) => {
          if (at !== 'plan') return;
          mkdirSync(join(root, 'sources', 'dropbox.files'), { recursive: true });
          throw new AccountMigrationKilled(at);
        };
      }
      expect(() => migrateAccountFolders(env), variant).toThrow(AccountMigrationKilled);
      __accountMigrationTestHooks.reset();
      const moves = entryOf(env, 'dropbox.files')!.migration!.moves!;
      expect(moves.length, variant).toBeGreaterThan(5);
      expect(moves.every((move) => existsSync(join(root, ...move.from.split('/')))), `${variant}: nothing had moved`).toBe(true);
      if (variant.startsWith('the first run')) expect(existsSync(chainOf(root).at(-1)!), variant).toBe(true);

      // The restarted worker finds the folders, makes none, and must still make the whole chain durable first.
      const syncedBeforeAnyOldNameWent = new Set<string>();
      __accountMigrationTestHooks.syncDirectory = (folder) => {
        const anOldNameWent = moves.some((move) => !existsSync(join(root, ...move.from.split('/'))));
        if (!anOldNameWent) syncedBeforeAnyOldNameWent.add(folder);
      };
      const report = migrateAccountFolders(withoutSwitch(env));

      expect(report.moved, variant).toEqual(['dropbox.files']);
      // Synced by their real paths (the temporary folder may itself be reached through a link).
      for (const folder of chainOf(realpathSync(root))) expect(syncedBeforeAnyOldNameWent.has(folder), `${variant}: ${relative(realpathSync(root), folder) || 'the data folder'} was not synced before the first old name went`).toBe(true);
    }
  });

  test('a data folder that is a link: the real folders it leads to are synced before the first old name goes', () => {
    const { dir, env, root } = fixture();
    const real = join(dir, 'elsewhere', 'olympus');
    mkdirSync(real, { recursive: true });
    mkdirSync(dirname(root), { recursive: true });
    symlinkSync(real, root);
    install(env, 'dropbox.files', { walOn: 'none' });
    const syncedBeforeAnyOldNameWent = new Set<string>();
    let moves: SourceRegistryMove[] = [];
    onCheckpoint((point) => {
      if (point === 'plan') moves = entryOf(env, 'dropbox.files')?.migration?.moves ?? [];
    });
    __accountMigrationTestHooks.syncDirectory = (folder) => {
      if (moves.length > 0 && moves.every((move) => existsSync(join(root, ...move.from.split('/'))))) syncedBeforeAnyOldNameWent.add(folder);
    };
    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);
    for (const folder of chainOf(realpathSync(real))) expect(syncedBeforeAnyOldNameWent.has(folder), `${relative(realpathSync(real), folder) || 'the real data folder'} was not synced before the first old name went`).toBe(true);
  });

  test('going back, the folders the files return to are synced before the first file is moved back', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files');
    lieAboutLedgerSize(env);
    const watch = spy(env, root);

    expect(migrateAccountFolders(env).movedBack).toHaveLength(1);

    const moves = watch.moves();
    const legacyFolders = new Set(moves.map((move) => dirname(watch.at(move.from))));
    expect(legacyFolders.size).toBeGreaterThan(0);
    // Syncs after the put-back began and before any file had its old name again.
    const beforeFirstLink = watch.syncs.filter((sync) => sync.afterRevert && [...sync.states.values()].every((state) => state === 'new'));
    for (const folder of legacyFolders) {
      expect(beforeFirstLink.some((sync) => sync.folder === realpathSync(folder)), `${relative(root, folder) || 'the data folder'} was not synced before the first file went back`).toBe(true);
    }
  });
});

describe('another program holding a database does not hold the boot', () => {
  const opened: Database[] = [];
  afterEach(() => {
    for (const db of opened.splice(0)) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // No transaction open.
      }
      db.close();
    }
  });

  /** Another program takes the whole database for itself, as an exclusive writer does: nothing else reads it until it lets go. */
  function holdExclusively(path: string): Database {
    const holder = new Database(path, { readwrite: true });
    opened.push(holder);
    holder.exec('PRAGMA locking_mode = EXCLUSIVE');
    holder.exec('BEGIN EXCLUSIVE');
    holder.query('INSERT INTO t VALUES (?)').run('held');
    return holder;
  }
  const release = (holder: Database): void => {
    holder.exec('ROLLBACK');
    holder.close();
    opened.length = 0;
  };

  test('taken after the logs were folded: the account stays where it is, said as busy, within the cap of one wait', () => {
    const { env, root } = fixture();
    const [store] = install(env, 'dropbox.files', { walOn: 'none' });
    let holder: Database | undefined;
    onCheckpoint((at) => {
      if (at === 'folded') holder = holdExclusively(store!);
    });

    const started = Date.now();
    const report = migrateAccountFolders(env);
    const spent = Date.now() - started;

    expect(report.skipped, JSON.stringify(report)).toEqual([{ sourceId: 'dropbox.files', reason: 'busy' }]);
    expect(report.moved).toEqual([]);
    // One wait, not one per way of looking at one database, and not one per database.
    expect(spent).toBeLessThan(LOCK_WAIT_CAP_MS + 1_500);
    expect(existsSync(join(root, 'sources'))).toBe(false);
    expect(entryOf(env, 'dropbox.files')).toMatchObject({ layout: 'legacy', migration: { state: 'skipped', reason: 'busy' } });
    expect(sourceStorageNotices(env)).toEqual([]);
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(true);

    // When the other program lets go, the next boot moves it.
    release(holder!);
    __accountMigrationTestHooks.reset();
    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);
  }, 60_000);

  test('every database of an account held: still one wait, not one for each', () => {
    const { env } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    const databases = legacy.filter((path) => path.endsWith('.sqlite'));
    expect(databases.length).toBeGreaterThan(3);
    const holders: Database[] = [];
    onCheckpoint((at) => {
      if (at === 'folded') for (const path of databases) holders.push(holdExclusively(path));
    });

    const started = Date.now();
    const report = migrateAccountFolders(env);
    const spent = Date.now() - started;

    expect(report.skipped).toEqual([{ sourceId: 'dropbox.files', reason: 'busy' }]);
    expect(spent).toBeLessThan(LOCK_WAIT_CAP_MS + 1_500);
    for (const holder of holders) release(holder);
  }, 60_000);

  test('a wait is no longer than what is left of the boot\'s deadline', () => {
    const { env } = fixture();
    const [store] = install(env, 'dropbox.files', { walOn: 'none' });
    // A clock that stands still, and a deadline 300 ms away: that is all the waiting there is.
    __accountMigrationTestHooks.now = () => 1_000_000;
    __accountMigrationTestHooks.budgetMs = 300;
    onCheckpoint((at) => {
      if (at === 'folded') holdExclusively(store!);
    });

    const started = Date.now();
    const report = migrateAccountFolders(env);
    const spent = Date.now() - started;

    expect(report.skipped).toEqual([{ sourceId: 'dropbox.files', reason: 'busy' }]);
    expect(spent).toBeLessThan(LOCK_WAIT_CAP_MS - 500);
  }, 60_000);

  test('already held when the pass starts: the fold waits no longer than the deadline leaves either', () => {
    const { env } = fixture();
    const [store] = install(env, 'dropbox.files', { walOn: 'first' });
    __accountMigrationTestHooks.now = () => 1_000_000;
    __accountMigrationTestHooks.budgetMs = 300;
    holdExclusively(store!);

    const started = Date.now();
    const report = migrateAccountFolders(env);
    const spent = Date.now() - started;

    expect(report.skipped).toEqual([{ sourceId: 'dropbox.files', reason: 'busy' }]);
    expect(spent).toBeLessThan(LOCK_WAIT_CAP_MS - 500);
  }, 60_000);

  test('taken once the files have moved, before the check that they open: everything goes back, as a skip, with no Needs you row', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    const store = legacy[0]!;
    const target = destinationOf(env, store, 'dropbox.files');
    const original = identity(store);
    let holder: Database | undefined;
    onCheckpoint((at) => {
      const last = (entryOf(env, 'dropbox.files')?.migration?.moves?.length ?? 1) - 1;
      if (at === `rename:${last}` && !holder) holder = holdExclusively(target);
    });

    const started = Date.now();
    const report = migrateAccountFolders(env);
    const spent = Date.now() - started;

    expect(report.skipped, JSON.stringify(report)).toEqual([{ sourceId: 'dropbox.files', reason: 'busy' }]);
    expect(report.movedBack).toEqual([]);
    expect(spent).toBeLessThan(LOCK_WAIT_CAP_MS + 2_500);
    expect(identity(store)).toBe(original);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(root, 'sources', 'dropbox.files', '1', 'stores', basename(target)))).toBe(false);
    expect(entryOf(env, 'dropbox.files')).toMatchObject({ layout: 'legacy', migration: { state: 'skipped', reason: 'busy' } });
    expect(sourceStorageNotices(env)).toEqual([]);
    release(holder!);
  }, 60_000);

  test('a database that is only unreadable is damaged, not busy: the account still moves', () => {
    const { env } = fixture();
    const [store] = install(env, 'dropbox.files', { walOn: 'none' });
    writeFileSync(store!, Buffer.alloc(64, 7));

    const report = migrateAccountFolders(env);

    expect(report.moved).toEqual(['dropbox.files']);
    expect(entryOf(env, 'dropbox.files')!.migration?.checked?.some((checked) => checked.result === 'damaged')).toBe(true);
  });
});

describe('an imported archive is checked like every other source', () => {
  const family = archiveImportFamilies()[0]!;
  const files = (env: Env) => legacyAccountFiles('archive.imports', env, archiveImportFamilies()).filter((file) => file.area === 'store');

  test('a corpus the registry lists whose store is not at the usual place keeps the account where it is', () => {
    const { env, root } = fixture();
    seedLegacy(env, 'archive.imports', { walOn: 'none' });
    const listed = files(env).find((file) => file.name === `${family}.secure_local`)!;
    // The listed corpus's store (with its sidecars) is somewhere else, as an override once put it.
    for (const base of [listed.legacy, tierLedgerPathForStore(listed.legacy), secretLocationsPathForStore(listed.legacy), tierSnifferPathForStore(listed.legacy)]) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${base}${suffix}`, { force: true });
    }
    recordLegacy(env, 'archive.imports', [archiveCorpusId('secure_local', family)]);
    const before = tree(root);

    const report = migrateAccountFolders(env);

    expect(report.skipped).toEqual([{ sourceId: 'archive.imports', reason: 'files_elsewhere' }]);
    expect(report.moved).toEqual([]);
    expect(existsSync(join(root, 'sources'))).toBe(false);
    expect(entryOf(env, 'archive.imports')!.layout).toBe('legacy');
    const strip = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([name]) => !name.startsWith('registry.json') && !name.includes('.lock')));
    expect(strip(tree(root))).toEqual(strip(before));
  });

  test('with the listed store in its place the account moves, and nothing is opened empty afterwards', () => {
    const { env } = fixture();
    seedLegacy(env, 'archive.imports', { walOn: 'none' });
    recordLegacy(env, 'archive.imports', [archiveCorpusId('secure_local', family), archiveCorpusId('internal', family)]);

    expect(migrateAccountFolders(env).moved).toEqual(['archive.imports']);

    const folder = accountFolder({ source_id: 'archive.imports', slot: '1' }, env);
    for (const tier of ['secure_local', 'internal']) expect(existsSync(join(folder, 'stores', `${family}.${tier}.sqlite`))).toBe(true);
  });
});

describe('a folder on the way that is a link is never followed', () => {
  test('a link in the account folder, to somewhere else on the same device, keeps the account where it is', () => {
    const { env, dir } = fixture();
    const legacy = install(env, 'dropbox.files');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    const folder = accountFolder({ source_id: 'dropbox.files', slot: '1' }, env);
    mkdirSync(folder, { recursive: true });
    symlinkSync(elsewhere, join(folder, 'stores'));

    const report = migrateAccountFolders(env);

    expect(report.skipped).toEqual([{ sourceId: 'dropbox.files', reason: 'unexpected_file' }]);
    expect(report.moved).toEqual([]);
    expect(readdirSync(elsewhere)).toEqual([]);
    for (const path of legacy) expect(existsSync(path), path).toBe(true);
    expect(entryOf(env, 'dropbox.files')!.layout).toBe('legacy');
  });

  test('a link in the data folder\'s sources folder is not followed either', () => {
    const { env, dir, root } = fixture();
    const legacy = install(env, 'dropbox.files');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, 'sources'));

    expect(migrateAccountFolders(env).skipped).toEqual([{ sourceId: 'dropbox.files', reason: 'unexpected_file' }]);
    expect(readdirSync(elsewhere)).toEqual([]);
    for (const path of legacy) expect(existsSync(path), path).toBe(true);
  });

  test('a link made after the plan is written and before the first folder is: nothing is made through it, and nothing has moved', () => {
    const { env, dir, root } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'none' });
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'plan') symlinkSync(elsewhere, join(root, 'sources'));
    };

    const report = migrateAccountFolders(env);

    expect(report.movedBack).toEqual([{ sourceId: 'dropbox.files', reason: 'move_failed' }]);
    expect(readdirSync(elsewhere)).toEqual([]);
    for (const path of legacy) expect(existsSync(path), path).toBe(true);
    expect(entryOf(env, 'dropbox.files')!.layout).toBe('legacy');
  });

  test('a folder that becomes a link in the middle of the move is not followed for the files after it: what moved goes back', () => {
    const { env, dir } = fixture();
    const legacy = install(env, 'local.files', { walOn: 'none' });
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    const folder = accountFolder({ source_id: 'local.files', slot: '1' }, env);
    let swapped = false;
    __accountMigrationTestHooks.checkpoint = (at) => {
      // After the move just before the first one into `raw/`.
      const moves = entryOf(env, 'local.files')?.migration?.moves;
      const next = moves?.[Number(at.startsWith('rename:') ? at.slice(7) : -2) + 1];
      if (swapped || !next || !next.to.includes('/raw/')) return;
      swapped = true;
      rmSync(join(folder, 'raw'), { recursive: true, force: true });
      symlinkSync(elsewhere, join(folder, 'raw'));
    };

    const report = migrateAccountFolders(env);

    expect(swapped).toBe(true);
    expect(report.movedBack).toEqual([{ sourceId: 'local.files', reason: 'move_failed' }]);
    expect(readdirSync(elsewhere)).toEqual([]);
    for (const path of legacy.filter((file) => !/-(wal|shm)$/.test(file))) expect(existsSync(path), path).toBe(true);
    expect(entryOf(env, 'local.files')!.layout).toBe('legacy');
  });
});

describe('what one boot can spend is bounded, and the bounds are looked at before the work', () => {
  const sizeOf = (env: Env, root: string, store: string): string => relative(root, destinationOf(env, store, 'dropbox.files'));
  const resultOf = (env: Env, file: string): string | undefined =>
    entryOf(env, 'dropbox.files')!.migration!.checked!.find((check) => check.file === file)?.result;

  test('a store is judged by its file and its write-ahead log together', () => {
    const probe = fixture();
    const [store] = install(probe.env, 'dropbox.files', { walOn: 'first' });
    const main = statSync(store!).size;
    const wal = statSync(`${store}-wal`).size;
    expect(wal).toBeGreaterThan(0);

    const judged = (cap: number): string | undefined => {
      const { env, root } = fixture();
      const [first] = install(env, 'dropbox.files', { walOn: 'first' });
      __accountMigrationTestHooks.limits = { quickCheckStoreMaxBytes: cap };
      migrateAccountFolders(env);
      __accountMigrationTestHooks.reset();
      return resultOf(env, sizeOf(env, root, first!));
    };

    expect(judged(main + wal + 1)).toBe('ok');
    expect(judged(main + 1), 'the file alone would fit; with its log it does not').toBe('not_checked');
  });

  test('all the databases of a boot share a byte allowance', () => {
    const { env, root } = fixture();
    const [first] = install(env, 'dropbox.files', { walOn: 'none' });
    __accountMigrationTestHooks.limits = { quickCheckTotalMaxBytes: statSync(first!).size + 1 };

    migrateAccountFolders(env);

    const checked = entryOf(env, 'dropbox.files')!.migration!.checked!;
    expect(resultOf(env, sizeOf(env, root, first!))).toBe('ok');
    expect(checked.filter((check) => check.result === 'ok')).toHaveLength(1);
    expect(checked.length).toBeGreaterThan(3);
  });

  test('a database that would not finish in the time left is not checked: the time is looked at before the check, not after', () => {
    const { env, root } = fixture();
    const [first] = install(env, 'dropbox.files', { walOn: 'none' });
    // A store of about 11 MiB: at the slowest disk the bounds allow for it needs over a second.
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${first}${suffix}`, { force: true });
    const big = new Database(first!);
    big.exec('PRAGMA journal_mode = DELETE; CREATE TABLE t (v BLOB)');
    for (let index = 0; index < 11; index += 1) big.query('INSERT INTO t VALUES (zeroblob(1048576))').run();
    big.close();
    __accountMigrationTestHooks.quickCheckBudgetMs = 1000;

    migrateAccountFolders(env);

    expect(resultOf(env, sizeOf(env, root, first!))).toBe('not_checked');
    // The small ones still fit in what is left.
    const checked = entryOf(env, 'dropbox.files')!.migration!.checked!;
    expect(checked.some((check) => check.result === 'ok')).toBe(true);
  });

  test('a plan left part way waits for the next boot too once the boot is out of time', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files');
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'plan') throw new AccountMigrationKilled(at);
    };
    expect(() => migrateAccountFolders(env)).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    __accountMigrationTestHooks.budgetMs = -1;

    const report = migrateAccountFolders(env);

    expect(report.deferred).toContain('dropbox.files');
    expect(report.moved).toEqual([]);
    expect(entryOf(env, 'dropbox.files')!.migration?.state).toBe('moving');
    for (const path of legacy) expect(existsSync(path) || /-(wal|shm)$/.test(path), path).toBe(true);
    expect(existsSync(join(root, 'sources', 'dropbox.files', '1', 'stores'))).toBe(false);

    __accountMigrationTestHooks.reset();
    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);
  });

  test('an account whose write-ahead logs are large waits: opening a database reads its log, so the logs a move carries are bounded', () => {
    const { env, root } = fixture();
    const legacy = install(env, 'dropbox.files', { walOn: 'first' });
    __accountMigrationTestHooks.limits = { accountLogMaxBytes: 1 };

    const report = migrateAccountFolders(env);

    expect(report.skipped).toEqual([{ sourceId: 'dropbox.files', reason: 'log_large' }]);
    expect(existsSync(join(root, 'sources'))).toBe(false);
    for (const path of legacy.filter((file) => !/-shm$/.test(file))) expect(existsSync(path), path).toBe(true);
    // Not a Needs you row: the logs are folded in when Olympus next stops cleanly.
    expect(sourceStorageNotices(env)).toEqual([]);

    __accountMigrationTestHooks.reset();
    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);
  });
});
