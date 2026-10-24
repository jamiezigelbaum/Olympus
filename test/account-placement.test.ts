// Where a new account's files go (docs/design/source-storage.md, delivery step
// 4a): a folder, unless something says it already lives elsewhere; the
// registry's entry once it has one; the same answer in every process. The
// legacy paths themselves are pinned by test/account-layout-golden.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { archiveImportFamilies } from '../src/core/archive-formats.ts';
import { FOLDER_LAYOUT_SOURCES, accountFolder, legacyAccountPaths, legacyOverrideEnvNames, olympusDataRoot } from '../src/core/olympus-layout.ts';
import {
  decideAccountLayout,
  hasFolderLayout,
  isInsideAccountFolder,
  placedAccount,
  resolvedRawPath,
  resolvedStorePath,
} from '../src/core/source-placement.ts';
import { readSourceRegistry, sourceRegistryPath, updateSourceRegistry } from '../src/core/source-registry.ts';
import {
  SourceRegistryError as Step3RegistryError,
  readSourceRegistry as readSourceRegistryAsStep3,
} from './fixtures/source-registry-step3.ts';
import { __sourceStorageTestHooks, enableSourceRegistryAdoption, openConnectorStore } from '../src/core/source-storage.ts';
import { lifecycleSourceSpecs } from '../src/data-lifecycle.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { archiveConnectorStoreDbPath } from '../src/workers/archive-import/store.ts';
import { defaultReadwiseConnectorStoreDbPath } from '../src/workers/readwise/connector.ts';
import { defaultXBookmarksConnectorStoreDbPath } from '../src/workers/x-bookmarks/connector.ts';

type Env = Record<string, string>;

const MOUNTS = 'OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON';

let dir: string;
let env: Env;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-account-placement-'));
  env = { HOME: dir, XDG_DATA_HOME: join(dir, 'data') };
});

afterEach(() => {
  __sourceStorageTestHooks.disableAdoption();
  rmSync(dir, { recursive: true, force: true });
});

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}

/** Every file a source could already have at its legacy locations, with the sidecars a store gets. */
function legacyFiles(sourceId: string): string[] {
  const { stores, raw } = legacyAccountPaths(sourceId, env, archiveImportFamilies());
  return [...stores, ...stores.map(tierLedgerPathForStore), ...stores.map((store) => `${store}-wal`), ...raw];
}

describe('placement: a new account', () => {
  test('every source with a folder layout is placed in a folder on a fresh install, and only those', () => {
    expect(FOLDER_LAYOUT_SOURCES).toEqual([
      'gmail.email',
      'google_drive.docs',
      'dropbox.files',
      'local.files',
      'readwise.library',
      'x.bookmarks',
      'archive.imports',
    ]);
    for (const sourceId of FOLDER_LAYOUT_SOURCES) {
      expect(decideAccountLayout(sourceId, env).layout).toBe('folder');
      expect(placedAccount(sourceId, env)).toEqual({ source_id: sourceId, slot: '1', layout: 'folder' });
    }
    // Messaging, Reflect and Roam stay where they are, whatever the disk looks like.
    const others = lifecycleSourceSpecs().map((spec) => spec.sourceId).filter((id) => !FOLDER_LAYOUT_SOURCES.includes(id));
    expect(others).toEqual(['telegram.messages', 'whatsapp.personal.messages', 'reflect.notes', 'roam.notes']);
    for (const sourceId of others) {
      expect(hasFolderLayout(sourceId)).toBe(false);
      expect(decideAccountLayout(sourceId, env).layout).toBe('legacy');
      expect(placedAccount(sourceId, env).layout).toBe('legacy');
    }
  });

  test('a data folder that does not exist yet is fresh, and nothing is created by asking', () => {
    expect(existsSync(olympusDataRoot(env))).toBe(false);
    expect(decideAccountLayout('x.bookmarks', env).layout).toBe('folder');
    resolvedStorePath('x.bookmarks', 'internal', env);
    expect(existsSync(olympusDataRoot(env))).toBe(false);
  });

  test.each(FOLDER_LAYOUT_SOURCES.map((id) => [id]))('%s: any file at a legacy location places it legacy', (sourceId) => {
    const files = legacyFiles(sourceId);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      touch(file);
      const decision = decideAccountLayout(sourceId, env);
      expect(decision.layout).toBe('legacy');
      expect(decision.why).toContain('legacy');
      rmSync(file, { recursive: true, force: true });
      expect(decideAccountLayout(sourceId, env).layout).toBe('folder');
    }
  });

  test('the sidecars of a store count, even with the store itself gone', () => {
    const store = defaultReadwiseConnectorStoreDbPath(env);
    expect(store).toBe(join(olympusDataRoot(env), 'sources', 'readwise.library', '1', 'stores', 'internal.sqlite'));
    const legacyStore = join(olympusDataRoot(env), 'readwise-connector-store.sqlite');
    for (const sidecar of [
      tierLedgerPathForStore(legacyStore),
      `${legacyStore}-shm`,
      join(olympusDataRoot(env), 'readwise-secure-connector-store.secret-locations.sqlite'),
      join(olympusDataRoot(env), 'readwise-secure-connector-store.tier-sniffer.sqlite'),
    ]) {
      touch(sidecar);
      expect(decideAccountLayout('readwise.library', env).layout).toBe('legacy');
      rmSync(sidecar, { force: true });
    }
  });

  test('lock files, shared files and another source\'s files do not count', () => {
    const root = olympusDataRoot(env);
    for (const file of [
      'data-owner.lock',
      'registry.json.lock.db',
      'x-bookmarks-api-usage.sqlite',
      'readwise-daily-request-budget.json.sqlite',
      'source-dashboard.sqlite',
      'telegram-internal-connector-store.sqlite',
    ]) touch(join(root, file));
    touch(join(root, 'gmail-connector-store.sqlite'));
    expect(decideAccountLayout('x.bookmarks', env).layout).toBe('folder');
    expect(decideAccountLayout('readwise.library', env).layout).toBe('folder');
    expect(decideAccountLayout('google_drive.docs', env).layout).toBe('folder');
    expect(decideAccountLayout('gmail.email', env).layout).toBe('legacy');
  });

  test.each(FOLDER_LAYOUT_SOURCES.map((id) => [id]))('%s: an env override pins it legacy', (sourceId) => {
    const names = legacyOverrideEnvNames(sourceId);
    if (sourceId === 'archive.imports') expect(names).toEqual(['OLYMPUS_ARCHIVE_IMPORTS_STATE_PATH']);
    else expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const pinned = { ...env, [name]: join(dir, 'elsewhere', 'file') };
      expect(decideAccountLayout(sourceId, pinned)).toEqual({ layout: 'legacy', why: `${name} pins its files` });
      // Blank is unset, as every legacy resolver treated it.
      expect(decideAccountLayout(sourceId, { ...env, [name]: '  ' }).layout).toBe('folder');
    }
  });

  test('a connector-store mount that names the account\'s corpus pins it legacy; another source\'s does not', () => {
    const mount = (corpusId: string, trustDomain: string) => JSON.stringify([{ corpusId, trustDomain, dbPath: join(dir, 'mount.sqlite') }]);
    const mounted = { ...env, [MOUNTS]: mount('internal.readwise.library', 'internal') };
    expect(decideAccountLayout('readwise.library', mounted).layout).toBe('legacy');
    expect(decideAccountLayout('readwise.library', mounted).why).toContain(MOUNTS);
    expect(decideAccountLayout('x.bookmarks', mounted).layout).toBe('folder');
    // An archive corpus of any family belongs to archive.imports.
    const archive = { ...env, [MOUNTS]: mount('secure_local.archive.chat.example', 'secure_local') };
    expect(decideAccountLayout('x.bookmarks', archive).layout).toBe('folder');
    // A list nobody can read moves nothing.
    for (const text of ['{ not json', '{"corpusId":"x"}']) {
      for (const sourceId of FOLDER_LAYOUT_SOURCES) {
        expect(decideAccountLayout(sourceId, { ...env, [MOUNTS]: text }).layout).toBe('legacy');
      }
    }
  });

  test('a data folder that cannot be looked at places it legacy rather than risk a second, empty set of stores', () => {
    // A dangling link where the data folder should be.
    mkdirSync(dirname(olympusDataRoot(env)), { recursive: true });
    symlinkSync(join(dir, 'missing'), olympusDataRoot(env));
    for (const sourceId of FOLDER_LAYOUT_SOURCES) {
      expect(decideAccountLayout(sourceId, env)).toEqual({ layout: 'legacy', why: 'the data folder cannot be looked at' });
    }
    rmSync(olympusDataRoot(env));
    // A file where the folder should be.
    writeFileSync(olympusDataRoot(env), '');
    expect(decideAccountLayout('x.bookmarks', env).layout).toBe('legacy');
  });

  test('a data folder the process may not search places it legacy', () => {
    if (process.getuid?.() === 0) return; // root searches any folder
    const root = olympusDataRoot(env);
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o000);
    try {
      for (const sourceId of FOLDER_LAYOUT_SOURCES) expect(decideAccountLayout(sourceId, env).layout).toBe('legacy');
    } finally {
      chmodSync(root, 0o700);
    }
  });

  test('a dangling link at a legacy path is evidence of legacy, not an absent file', () => {
    const root = olympusDataRoot(env);
    mkdirSync(root, { recursive: true });
    symlinkSync(join(dir, 'missing'), join(root, 'readwise-connector-store.sqlite'));
    expect(decideAccountLayout('readwise.library', env)).toEqual({ layout: 'legacy', why: 'its files are already at the legacy paths' });
  });

  test('a registry that cannot be read leaves it to what is on disk: a folder is a folder, else the legacy paths', () => {
    mkdirSync(dirname(sourceRegistryPath(env)), { recursive: true });
    writeFileSync(sourceRegistryPath(env), 'not json');
    expect(placedAccount('readwise.library', env).layout).toBe('legacy');
    expect(defaultReadwiseConnectorStoreDbPath(env)).toBe(join(olympusDataRoot(env), 'readwise-connector-store.sqlite'));
    mkdirSync(accountFolder({ source_id: 'readwise.library', slot: '1' }, env), { recursive: true });
    expect(placedAccount('readwise.library', env).layout).toBe('folder');
    expect(defaultReadwiseConnectorStoreDbPath(env)).toBe(join(accountFolder({ source_id: 'readwise.library', slot: '1' }, env), 'stores', 'internal.sqlite'));
    // Another source with no folder stays on its legacy paths.
    expect(placedAccount('x.bookmarks', env).layout).toBe('legacy');
  });
});

describe('placement: the registry\'s entry wins once there is one', () => {
  const entry = (sourceId: string, layout: 'legacy' | 'folder') => ({
    source_id: sourceId,
    slot: '1',
    state: 'active' as const,
    layout,
    corpus_ids: [],
    created_at: '2026-10-24T00:00:00.000Z',
  });

  test('a folder entry is a folder, whatever is at the legacy paths or in the environment', () => {
    updateSourceRegistry(env, (registry) => { registry.accounts.push(entry('readwise.library', 'folder')); });
    touch(join(olympusDataRoot(env), 'readwise-connector-store.sqlite'));
    const pinned = { ...env, OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_DB_PATH: join(dir, 'elsewhere.sqlite') };
    // A folder account never honors a per-store override.
    expect(resolvedStorePath('readwise.library', 'internal', pinned)).toBe(join(accountFolder({ source_id: 'readwise.library', slot: '1' }, pinned), 'stores', 'internal.sqlite'));
    expect(defaultReadwiseConnectorStoreDbPath(pinned)).toBe(resolvedStorePath('readwise.library', 'internal', pinned));
  });

  test('a legacy entry stays legacy with nothing at the legacy paths', () => {
    updateSourceRegistry(env, (registry) => { registry.accounts.push(entry('x.bookmarks', 'legacy')); });
    expect(decideAccountLayout('x.bookmarks', env).layout).toBe('folder');
    expect(placedAccount('x.bookmarks', env).layout).toBe('legacy');
    expect(defaultXBookmarksConnectorStoreDbPath(env)).toBe(join(olympusDataRoot(env), 'x-bookmarks-connector-store.sqlite'));
  });

  test('the X reconcile state follows the layout; the usage ledger stays shared', () => {
    const folder = placedAccount('x.bookmarks', env);
    expect(folder.layout).toBe('folder');
    expect(resolvedRawPath('x.bookmarks', 'x-reconcile.sqlite', env)).toBe(join(accountFolder(folder, env), 'raw', 'x-reconcile.sqlite'));
    updateSourceRegistry(env, (registry) => { registry.accounts.push(entry('x.bookmarks', 'legacy')); });
    expect(resolvedRawPath('x.bookmarks', 'x-reconcile.sqlite', env)).toBe(join(olympusDataRoot(env), 'x-bookmarks-api-usage.sqlite.reconcile'));
  });
});

describe('the schema follows the layouts, and an older build fails closed', () => {
  test('the first folder account makes the registry schema 2; a build that only knows schema 1 refuses to read it', () => {
    enableSourceRegistryAdoption();
    const readwise = openConnectorStore({ sourceId: 'readwise.library' }, {
      dbPath: defaultReadwiseConnectorStoreDbPath(env),
      corpusId: 'internal.readwise.library',
      family: 'readwise',
      trustDomain: 'internal',
    }, env);
    readwise.close();
    const text = readFileSync(sourceRegistryPath(env), 'utf8');
    expect(JSON.parse(text).schema).toBe(2);
    expect(readSourceRegistry(env).accounts.map((account) => account.layout)).toEqual(['folder']);
    // The step-3 reader, verbatim: it does not know schema 2, so it treats the file as unreadable
    // (the storage service then opens nothing) instead of opening empty stores at the legacy paths.
    let thrown: unknown;
    try {
      readSourceRegistryAsStep3(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Step3RegistryError);
    expect((thrown as Error).message).toContain('unknown schema 2');
    expect((thrown as Error).message).toContain(sourceRegistryPath(env));
  });

  test('an install with no folder account keeps a schema-1 file the step-3 reader can still read', () => {
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push({ source_id: 'telegram.messages', slot: '1', state: 'active', layout: 'legacy', corpus_ids: ['internal.telegram'], created_at: '2026-10-24T00:00:00.000Z' });
    });
    expect(JSON.parse(readFileSync(sourceRegistryPath(env), 'utf8')).schema).toBe(1);
    expect(readSourceRegistryAsStep3(env).accounts).toHaveLength(1);
  });
});

describe('adoption records the decision before the first file exists', () => {
  const open = (sourceId: string, dbPath: string, corpusId: string, trustDomain: 'internal' | 'secure_local' = 'internal') =>
    openConnectorStore({ sourceId }, { dbPath, corpusId, family: 'file', trustDomain }, env);

  test('a new account is recorded as a folder and its store is created inside it', () => {
    enableSourceRegistryAdoption();
    const dbPath = defaultXBookmarksConnectorStoreDbPath(env);
    expect(existsSync(dbPath)).toBe(false);
    open('x.bookmarks', dbPath, 'internal.x.bookmarks').close();
    const entry = readSourceRegistry(env).accounts.find((account) => account.source_id === 'x.bookmarks');
    expect(entry).toMatchObject({ layout: 'folder', slot: '1', state: 'active', corpus_ids: ['internal.x.bookmarks'] });
    expect(existsSync(dbPath)).toBe(true);
    expect(isInsideAccountFolder(dbPath, { source_id: 'x.bookmarks', slot: '1' }, env)).toBe(true);
    // Nothing of X went to the legacy paths.
    for (const file of legacyFiles('x.bookmarks')) expect(existsSync(file)).toBe(false);
  });

  test('an account that already has files at the legacy paths is recorded legacy and keeps them', () => {
    const legacy = join(olympusDataRoot(env), 'x-bookmarks-connector-store.sqlite');
    open('x.bookmarks', legacy, 'internal.x.bookmarks').close();
    expect(existsSync(sourceRegistryPath(env))).toBe(false); // adoption is off: nothing recorded
    enableSourceRegistryAdoption();
    const dbPath = defaultXBookmarksConnectorStoreDbPath(env);
    expect(dbPath).toBe(legacy);
    open('x.bookmarks', dbPath, 'internal.x.bookmarks').close();
    expect(readSourceRegistry(env).accounts.find((account) => account.source_id === 'x.bookmarks')?.layout).toBe('legacy');
    expect(existsSync(join(olympusDataRoot(env), 'sources'))).toBe(false);
  });

  test('a store opened at a path of the caller\'s own is recorded legacy even where the decision is a folder', () => {
    enableSourceRegistryAdoption();
    open('readwise.library', join(dir, 'mine.sqlite'), 'internal.readwise.library').close();
    expect(readSourceRegistry(env).accounts[0]).toMatchObject({ source_id: 'readwise.library', layout: 'legacy' });
    expect(JSON.parse(readFileSync(sourceRegistryPath(env), 'utf8')).schema).toBe(1);
  });

  test('messaging, Reflect and Roam are recorded legacy', () => {
    enableSourceRegistryAdoption();
    open('telegram.messages', join(olympusDataRoot(env), 'telegram-internal-connector-store.sqlite'), 'internal.telegram').close();
    open('reflect.notes', join(dir, 'reflect.sqlite'), 'secure_local.reflect.notes', 'secure_local').close();
    expect(readSourceRegistry(env).accounts.map((account) => [account.source_id, account.layout])).toEqual([
      ['telegram.messages', 'legacy'],
      ['reflect.notes', 'legacy'],
    ]);
    expect(existsSync(join(olympusDataRoot(env), 'sources'))).toBe(false);
  });

  test('a second tier opened later joins the folder the first one made', () => {
    enableSourceRegistryAdoption();
    open('readwise.library', defaultReadwiseConnectorStoreDbPath(env), 'internal.readwise.library').close();
    const secure = resolvedStorePath('readwise.library', 'secure_local', env);
    expect(dirname(secure)).toBe(dirname(defaultReadwiseConnectorStoreDbPath(env)));
    open('readwise.library', secure, 'secure_local.readwise.library', 'secure_local').close();
    const entry = readSourceRegistry(env).accounts[0]!;
    expect(entry.layout).toBe('folder');
    expect(entry.corpus_ids).toEqual(['internal.readwise.library', 'secure_local.readwise.library']);
  });
});

describe('an install that already has data keeps it', () => {
  test('legacy entries and files are untouched by opening, at schema 1', () => {
    const root = olympusDataRoot(env);
    const readwise = join(root, 'readwise-connector-store.sqlite');
    const dropbox = join(root, 'dropbox-files-connector-store.sqlite');
    updateSourceRegistry(env, (registry) => {
      for (const sourceId of ['readwise.library', 'dropbox.files']) {
        registry.accounts.push({ source_id: sourceId, slot: '1', state: 'active', layout: 'legacy', corpus_ids: [], created_at: '2026-10-24T00:00:00.000Z' });
      }
    });
    const before = readFileSync(sourceRegistryPath(env), 'utf8');
    enableSourceRegistryAdoption();
    // The legacy files are where the resolvers say, and X (no files, no entry) is the only new folder.
    expect(defaultReadwiseConnectorStoreDbPath(env)).toBe(readwise);
    expect(resolvedStorePath('dropbox.files', 'secure_local', env)).toBe(dropbox);
    openConnectorStore({ sourceId: 'readwise.library' }, { dbPath: readwise, corpusId: 'internal.readwise.library', family: 'readwise', trustDomain: 'internal' }, env).close();
    const afterReadwise = JSON.parse(readFileSync(sourceRegistryPath(env), 'utf8'));
    expect(afterReadwise.schema).toBe(1);
    expect(afterReadwise.accounts[0]).toMatchObject({ source_id: 'readwise.library', layout: 'legacy', corpus_ids: ['internal.readwise.library'] });
    expect(afterReadwise.accounts[1]).toEqual(JSON.parse(before).accounts[1]);
    expect(existsSync(join(root, 'sources'))).toBe(false);
  });
});

describe('every process reaches the same answer', () => {
  const script = (): string => {
    const here = join(import.meta.dir, '..', 'src');
    return `
      import { archiveImportFamilies } from '${here}/core/archive-formats.ts';
      import { archiveConnectorStoreDbPath } from '${here}/workers/archive-import/store.ts';
      import { defaultArchiveImportStatePath } from '${here}/workers/archive-import/state.ts';
      import { archiveImportRequestsPath } from '${here}/workers/archive-import/requests.ts';
      import { defaultGmailConnectorStoreDbPath, defaultGmailSecureConnectorStoreDbPath } from '${here}/workers/google-connectors/gmail.ts';
      import { defaultGoogleDriveConnectorStoreDbPath } from '${here}/workers/google-connectors/drive.ts';
      import { dropboxTierConnectorStoreDbPaths } from '${here}/workers/dropbox-files/connector-store.ts';
      import { localFilesTierConnectorStoreDbPaths, localFilesWatchDir } from '${here}/workers/local-files/store.ts';
      import { defaultReadwiseConnectorStoreDbPath } from '${here}/workers/readwise/connector.ts';
      import { defaultReadwiseSecureConnectorStoreDbPath } from '${here}/workers/readwise/tier-set.ts';
      import { defaultXBookmarksConnectorStoreDbPath } from '${here}/workers/x-bookmarks/connector.ts';
      import { defaultXBookmarksSecureConnectorStoreDbPath } from '${here}/workers/x-bookmarks/tier-set.ts';
      import { defaultXBookmarksApiUsageDbPath } from '${here}/workers/x-bookmarks/live-control.ts';
      import { defaultXBookmarksReconcileStateDbPath } from '${here}/workers/x-bookmarks/reconcile-state.ts';
      const env = process.env;
      console.log(JSON.stringify([
        defaultGmailConnectorStoreDbPath(env), defaultGmailSecureConnectorStoreDbPath(env),
        defaultGoogleDriveConnectorStoreDbPath(env),
        dropboxTierConnectorStoreDbPaths(env),
        localFilesTierConnectorStoreDbPaths(env), localFilesWatchDir(env),
        defaultReadwiseConnectorStoreDbPath(env), defaultReadwiseSecureConnectorStoreDbPath(env),
        defaultXBookmarksConnectorStoreDbPath(env), defaultXBookmarksSecureConnectorStoreDbPath(env),
        defaultXBookmarksApiUsageDbPath(env), defaultXBookmarksReconcileStateDbPath(env),
        archiveImportFamilies().map((family) => ['secure_local', 'internal', 'public_safe'].map((tier) => archiveConnectorStoreDbPath(tier, family, env))),
        defaultArchiveImportStatePath(env), archiveImportRequestsPath(defaultArchiveImportStatePath(env)),
      ]));
    `;
  };

  async function inAnotherProcess(): Promise<unknown> {
    const file = join(dir, 'resolve-paths.ts');
    writeFileSync(file, script());
    const child = Bun.spawn([process.execPath, file], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, XDG_DATA_HOME: join(dir, 'data') },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`resolver process failed: ${err}`);
    return JSON.parse(out);
  }

  function inThisProcess(): unknown {
    const families = archiveImportFamilies();
    const tiers = ['secure_local', 'internal', 'public_safe'] as const;
    return JSON.parse(JSON.stringify([
      resolvedStorePath('gmail.email', 'internal', env), resolvedStorePath('gmail.email', 'secure_local', env),
      resolvedStorePath('google_drive.docs', 'internal', env),
      tiers.map((tier) => resolvedStorePath('dropbox.files', tier, env)),
      tiers.map((tier) => resolvedStorePath('local.files', tier, env)), resolvedRawPath('local.files', 'watch', env),
      resolvedStorePath('readwise.library', 'internal', env), resolvedStorePath('readwise.library', 'secure_local', env),
      resolvedStorePath('x.bookmarks', 'internal', env), resolvedStorePath('x.bookmarks', 'secure_local', env),
      join(olympusDataRoot(env), 'x-bookmarks-api-usage.sqlite'), resolvedRawPath('x.bookmarks', 'x-reconcile.sqlite', env),
      families.map((family) => tiers.map((tier) => archiveConnectorStoreDbPath(tier, family, env))),
      resolvedRawPath('archive.imports', 'archive-imports.json', env), resolvedRawPath('archive.imports', 'archive-import-requests.json', env),
    ]));
  }

  test('the CLI (no adoption) and the worker (adoption) resolve the same paths before the entry exists and after', async () => {
    const before = inThisProcess();
    expect(await inAnotherProcess()).toEqual(before);
    // Every store path is in an account folder.
    expect(JSON.stringify(before)).toContain('/sources/x.bookmarks/1/stores/internal.sqlite');

    // The worker adopts: one writable open per account records its entry.
    enableSourceRegistryAdoption();
    for (const sourceId of FOLDER_LAYOUT_SOURCES) {
      if (sourceId === 'archive.imports') continue;
      openConnectorStore({ sourceId }, {
        dbPath: resolvedStorePath(sourceId, sourceId === 'dropbox.files' || sourceId === 'local.files' ? 'secure_local' : 'internal', env),
        corpusId: `internal.${sourceId}`,
        family: 'file',
        trustDomain: 'internal',
      }, env).close();
    }
    const entries = readSourceRegistry(env).accounts;
    expect(entries.map((account) => [account.source_id, account.layout])).toEqual([
      ['gmail.email', 'folder'],
      ['google_drive.docs', 'folder'],
      ['dropbox.files', 'folder'],
      ['local.files', 'folder'],
      ['readwise.library', 'folder'],
      ['x.bookmarks', 'folder'],
    ]);
    expect(inThisProcess()).toEqual(before);
    expect(await inAnotherProcess()).toEqual(before);
  }, 60_000);

  test('with files at the legacy paths and no entry, both resolve the legacy paths, and adoption keeps them', async () => {
    touch(join(olympusDataRoot(env), 'x-bookmarks-connector-store.sqlite'));
    touch(join(olympusDataRoot(env), 'gmail-connector-store.sqlite'));
    const before = inThisProcess();
    expect(await inAnotherProcess()).toEqual(before);
    expect(JSON.stringify(before)).toContain(join(olympusDataRoot(env), 'x-bookmarks-connector-store.sqlite'));
    expect(JSON.stringify(before)).toContain(join(olympusDataRoot(env), 'gmail-connector-store.sqlite'));
    // A source with no legacy file still gets its folder.
    expect(JSON.stringify(before)).toContain('/sources/readwise.library/1/stores/internal.sqlite');
    enableSourceRegistryAdoption();
    openConnectorStore({ sourceId: 'x.bookmarks' }, { dbPath: defaultXBookmarksConnectorStoreDbPath(env), corpusId: 'internal.x.bookmarks', family: 'x', trustDomain: 'internal' }, env).close();
    expect(inThisProcess()).toEqual(before);
    expect(await inAnotherProcess()).toEqual(before);
  }, 60_000);
});
