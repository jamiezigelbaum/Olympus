// The boot migration of existing accounts into their folders (docs/design/
// source-storage.md, "Migration of existing installs"; delivery step 4c).
// Everything runs on a throwaway data folder: real SQLite stores (with a
// pending WAL), real sidecars and raw state, the real registry, and the
// storage service's own refusals. Expected results are written from the
// design's rules (a rename keeps the file, a failed check puts everything
// back), not read back from the code under test.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { secretLocationsPathForStore, tierLedgerPathForStore, tierSnifferPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { archiveImportFamilies } from '../src/core/archive-formats.ts';
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
} from '../src/core/source-registry.ts';
import {
  SourceStorageUnavailableError,
  __sourceStorageTestHooks,
  isSourceAccountOpenable,
  openConnectorStore,
  sourceAccountUnavailableReason,
} from '../src/core/source-storage.ts';
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

function rowsOf(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
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

// ---------------------------------------------------------------------------

describe('the move', () => {
  test.each(migratableSources().map((sourceId) => [sourceId]))('%s: every file is renamed into its folder, same file, nothing copied', (sourceId) => {
    const { env, root } = fixture();
    const legacy = install(env, sourceId);
    const before = new Map(legacy.map((path) => [path, identity(path)]));
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
    for (const path of legacy) {
      expect(existsSync(path), `${path} is still at its old place`).toBe(false);
      const moved = destinationOf(env, path, sourceId);
      expect(identity(moved), `${moved} is not the same file`).toBe(before.get(path)!);
    }
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

  test('a store moves with its pending WAL: the rows that were only in the WAL are read at the new place', () => {
    const { env } = fixture();
    const [store] = install(env, 'dropbox.files', { walOn: 'first' });
    expect(existsSync(`${store}-wal`)).toBe(true);
    expect(rowsOf(store!)).toBe(3);

    migrateAccountFolders(env);

    const moved = resolvedStorePath('dropbox.files', 'secure_local', env);
    expect(existsSync(`${store}-wal`)).toBe(false);
    expect(rowsOf(moved)).toBe(3);
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
    expect(seen[0]).toBe('plan:legacy:moving');
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

  test('the steps are named: the plan, every rename, the checks, the re-keying and the flip', () => {
    const labels = labelsOf('dropbox.files');
    expect(labels[0]).toBe('plan');
    expect(labels.filter((label) => label.startsWith('rename:'))).toHaveLength(labels.length - 5);
    expect(labels.slice(-4)).toEqual(['verified', 'rebound', 'rekeyed', 'flipped']);
    expect(labels.length).toBeGreaterThan(20);
  });

  test.each(['dropbox.files', 'x.bookmarks', 'local.files'])('%s: killed after each step, the next boot ends with every file in its folder exactly once', (sourceId) => {
    const labels = labelsOf(sourceId);
    for (const label of labels) {
      const { env, root } = fixture();
      const legacy = install(env, sourceId, { walOn: 'all' });
      const before = new Map(legacy.map((path) => [path, identity(path)]));
      __accountMigrationTestHooks.checkpoint = (at) => {
        if (at === label) throw new AccountMigrationKilled(at);
      };
      expect(() => migrateAccountFolders(env), label).toThrow(AccountMigrationKilled);
      __accountMigrationTestHooks.reset();

      // While the move is part way the account is closed, whichever file is where.
      const entry = entryOf(env, sourceId)!;
      if (label !== 'flipped') {
        expect(sourceAccountMovePending(entry), label).toBe(true);
        expect(entry.layout, label).toBe('legacy');
        expect(readSourceRegistry(env).schema, label).toBe(3);
        expect(isSourceAccountOpenable({ sourceId }, env), label).toBe(false);
        expect(sourceAccountUnavailableReason({ sourceId }, env), label).toContain('being moved');
      }

      // A fresh boot, switch or no switch, finishes it.
      const boot = migrateAccountFolders(label === 'flipped' ? env : withoutSwitch(env));
      expect(boot.errors, label).toEqual([]);
      expect(boot.stuck, label).toEqual([]);
      expect(boot.resumed, label).toEqual(label === 'flipped' ? [] : [sourceId]);
      for (const path of legacy) {
        expect(existsSync(path), `${label}: ${path} is still at its old place`).toBe(false);
        expect(identity(destinationOf(env, path, sourceId)), `${label}: ${path}`).toBe(before.get(path)!);
      }
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

  test('files are back where they were, byte for byte; the account stays legacy with a Needs you row; the entry says what failed', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files', { walOn: 'all' });
    const before = tree(root);
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
      const before = tree(root);
      lieAboutOneSize(env, 'dropbox.files');
      __accountMigrationTestHooks.checkpoint = (at) => {
        if (at === label) throw new AccountMigrationKilled(at);
      };
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

  test('a rename that fails with EXDEV in the middle puts back what had moved, and is the same skip', () => {
    const { env, root } = fixture();
    install(env, 'dropbox.files', { walOn: 'all' });
    const before = tree(root);
    let renames = 0;
    __accountMigrationTestHooks.rename = (from, to) => {
      renames += 1;
      if (renames === 5) throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      renameSync(from, to);
    };

    const report = migrateAccountFolders(env);

    expect(report.skipped).toEqual([{ sourceId: 'dropbox.files', reason: 'other_device' }]);
    expect(report.movedBack).toEqual([]);
    const strip = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([name]) => !name.startsWith('registry.json') && !name.includes('.lock')));
    expect(strip(tree(root))).toEqual(strip(before));
    expect(existsSync(join(root, 'sources', 'dropbox.files'))).toBe(false);
    expect(entryOf(env, 'dropbox.files')!.migration).toMatchObject({ state: 'skipped', reason: 'other_device' });
    expect(entryOf(env, 'dropbox.files')!.layout).toBe('legacy');
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
