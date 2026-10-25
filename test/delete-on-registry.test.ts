// Delete on the registry (docs/design/source-storage.md, "Delete"; delivery
// step 5). The running worker forgets an account's shared rows and marks it
// `deleting`; from then on nothing opens it, and the next boot removes its
// files (a folder by one rename into the trash, a legacy account's files where
// the layout's resolvers put them), releases its pictures and drops the entry,
// so a reconnect starts a new account. data-lifecycle.ts knows no source.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { accountFolder, accountRawPath, accountStorePath, accountTrashRoot, olympusDataRoot } from '../src/core/olympus-layout.ts';
import { lifecycleSourceIds } from '../src/core/account-files.ts';
import { findRegistryAccount, readSourceRegistry, sourceRegistryPath, updateSourceRegistry } from '../src/core/source-registry.ts';
import {
  __sourceStorageTestHooks,
  enableSourceRegistryAdoption,
  openConnectorStore,
  SourceStorageUnavailableError,
} from '../src/core/source-storage.ts';
import { deleteMarkedAccounts, deleteOlympusData, exportOlympusData, lifecycleAccountFiles } from '../src/data-lifecycle.ts';
import { createReadwiseConnectorStore, defaultReadwiseConnectorStoreDbPath } from '../src/workers/readwise/connector.ts';
import { defaultReadwiseSecureConnectorStoreDbPath } from '../src/workers/readwise/tier-set.ts';
import { defaultXBookmarksApiUsageDbPath, LocalXBookmarksApiUsageStore } from '../src/workers/x-bookmarks/live-control.ts';

type Env = Record<string, string>;
const ROOT = join(import.meta.dir, '..');

const roots: string[] = [];
afterEach(() => {
  __sourceStorageTestHooks.disableAdoption();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { dir: string; homeDir: string; env: Env } {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-delete-registry-'));
  roots.push(dir);
  const homeDir = join(dir, 'home');
  return {
    dir,
    homeDir,
    env: {
      HOME: homeDir,
      XDG_DATA_HOME: join(homeDir, '.local', 'share'),
      XDG_STATE_HOME: join(homeDir, '.local', 'state'),
      PATH: process.env.PATH ?? '',
    },
  };
}

/** A connected Readwise (two tiers) as the worker opens it: a folder account on a fresh install. */
function connectReadwise(env: Env): string[] {
  enableSourceRegistryAdoption();
  createReadwiseConnectorStore(defaultReadwiseConnectorStoreDbPath(env), env).close();
  const secureDb = defaultReadwiseSecureConnectorStoreDbPath(env);
  openConnectorStore({ sourceId: 'readwise.library' }, {
    dbPath: secureDb,
    corpusId: 'secure_local.readwise.library',
    family: 'readwise',
    trustDomain: 'secure_local',
  }, env).close();
  __sourceStorageTestHooks.disableAdoption();
  return [defaultReadwiseConnectorStoreDbPath(env), secureDb];
}

function put(path: string, text = 'x'): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe('the running worker marks, the boot removes', () => {
  test('a folder account: marked and closed, then renamed away at boot, its entry dropped', () => {
    const { homeDir, env } = fixture();
    const stores = connectReadwise(env);
    const folder = accountFolder({ source_id: 'readwise.library', slot: '1' }, env);
    put(join(folder, 'raw', 'extraction-spool', 'scratch'));
    const otherAccount = put(join(olympusDataRoot(env), 'sources', 'x.bookmarks', '1', 'stores', 'internal.sqlite'));

    const marked = deleteOlympusData({ sourceId: 'readwise.library', homeDir, env, applyAtRestart: true });

    expect(marked).toMatchObject({ ok: true, mode: 'source', sourceId: 'readwise.library', dryRun: false, pending: true });
    expect(marked.removed).toEqual(expect.arrayContaining([...stores, folder]));
    // Nothing goes until the restart; nothing opens it meanwhile.
    for (const store of stores) expect(existsSync(store)).toBe(true);
    expect(findRegistryAccount(readSourceRegistry(env), 'readwise.library', '1')?.state).toBe('deleting');
    expect(() => openConnectorStore({ sourceId: 'readwise.library' }, {
      dbPath: stores[0]!,
      corpusId: 'internal.readwise.library',
      family: 'readwise',
      trustDomain: 'internal',
    }, env)).toThrow(SourceStorageUnavailableError);
    // An export leaves it out.
    expect(() => exportOlympusData({ destination: join(homeDir, 'out'), sourceId: 'readwise.library', homeDir, env })).toThrow('being deleted');

    const report = deleteMarkedAccounts({ homeDir, env });

    expect(report.failed).toEqual([]);
    expect(report.deleted.map((entry) => entry.sourceId)).toEqual(['readwise.library']);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(otherAccount)).toBe(true);
    expect(findRegistryAccount(readSourceRegistry(env), 'readwise.library', '1')).toBeUndefined();
    // The rename went into the trash, which is emptied (here at once, at boot in the background).
    const trash = accountTrashRoot(env);
    expect(existsSync(trash) ? readdirSync(trash).filter((name) => existsSync(join(trash, name, 'stores'))) : []).toEqual([]);
    // A second boot has nothing to do.
    expect(deleteMarkedAccounts({ homeDir, env })).toEqual({ deleted: [], failed: [] });
  });

  test('a reconnect after the boot starts a new account, placed afresh', () => {
    const { homeDir, env } = fixture();
    connectReadwise(env);
    const before = findRegistryAccount(readSourceRegistry(env), 'readwise.library', '1')!;
    deleteOlympusData({ sourceId: 'readwise.library', homeDir, env, applyAtRestart: true });
    deleteMarkedAccounts({ homeDir, env });

    connectReadwise(env);

    const after = findRegistryAccount(readSourceRegistry(env), 'readwise.library', '1')!;
    expect(after).toMatchObject({ state: 'active', layout: 'folder' });
    expect(after.created_at >= before.created_at).toBe(true);
  });

  test('a legacy account: its files go where the layout\'s resolvers put them, the X usage ledger stays', () => {
    const { homeDir, env } = fixture();
    // Files at the legacy paths with no entry (never adopted): the decision keeps the account legacy.
    const legacy = { source_id: 'x.bookmarks', slot: '1', layout: 'legacy' as const };
    const store = put(accountStorePath(legacy, 'internal', env));
    const reconcile = put(accountRawPath(legacy, 'x-reconcile.sqlite', env));
    const files = lifecycleAccountFiles('x.bookmarks', { homeDir, env });
    expect(files.account.layout).toBe('legacy');
    expect(files.stores).toContain(store);
    expect(files.rawDatabases.map((database) => database.path)).toEqual([reconcile]);
    const usagePath = defaultXBookmarksApiUsageDbPath(env);
    const usage = new LocalXBookmarksApiUsageStore(usagePath);
    usage.recordHeadCheckpoint('personal', '777');
    usage.close();

    const marked = deleteOlympusData({ sourceId: 'x.bookmarks', homeDir, env, applyAtRestart: true });
    expect(marked.forgotten).toContain(`${usagePath} (sync positions: 1)`);
    // The entry is made for the mark, at the layout its files are in.
    expect(findRegistryAccount(readSourceRegistry(env), 'x.bookmarks', '1')).toMatchObject({ state: 'deleting', layout: 'legacy' });
    expect(existsSync(store)).toBe(true);

    expect(deleteMarkedAccounts({ homeDir, env }).failed).toEqual([]);

    expect(existsSync(store)).toBe(false);
    expect(existsSync(reconcile)).toBe(false);
    expect(existsSync(usagePath)).toBe(true);
    expect(readSourceRegistry(env).accounts).toEqual([]);
  });

  test('a boot that cannot remove an account leaves it marked and closed, and a later one finishes', () => {
    const { dir, homeDir, env } = fixture();
    connectReadwise(env);
    const folder = accountFolder({ source_id: 'readwise.library', slot: '1' }, env);
    deleteOlympusData({ sourceId: 'readwise.library', homeDir, env, applyAtRestart: true });
    // Something links out of the folder's stores after the mark: the boot refuses rather than follow it.
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const stores = join(folder, 'stores');
    const moved = `${stores}-real`;
    require('node:fs').renameSync(stores, moved);
    symlinkSync(elsewhere, stores);

    const report = deleteMarkedAccounts({ homeDir, env });

    expect(report.deleted).toEqual([]);
    expect(report.failed.map((entry) => entry.sourceId)).toEqual(['readwise.library']);
    expect(findRegistryAccount(readSourceRegistry(env), 'readwise.library', '1')?.state).toBe('deleting');
    expect(existsSync(folder)).toBe(true);

    rmSync(stores);
    require('node:fs').renameSync(moved, stores);
    expect(deleteMarkedAccounts({ homeDir, env }).deleted.map((entry) => entry.sourceId)).toEqual(['readwise.library']);
    expect(existsSync(folder)).toBe(false);
  });

  test('a refused delete marks nothing and forgets nothing', () => {
    const { homeDir, env } = fixture();
    connectReadwise(env);
    const folder = accountFolder({ source_id: 'readwise.library', slot: '1' }, env);
    // Another source's store placed inside this folder by an override.
    const intruder = put(join(folder, 'raw', 'theirs.sqlite'));
    const envWithOverride = { ...env, OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_DB_PATH: intruder };
    expect(() => deleteOlympusData({ sourceId: 'readwise.library', homeDir, env: envWithOverride, applyAtRestart: true })).toThrow('overlaps');
    expect(findRegistryAccount(readSourceRegistry(env), 'readwise.library', '1')?.state).toBe('active');
  });

  test('the CLI, with nothing open, marks and removes at once', () => {
    const { homeDir, env } = fixture();
    const stores = connectReadwise(env);
    const result = deleteOlympusData({ sourceId: 'readwise.library', homeDir, env });
    expect(result.pending).toBeUndefined();
    for (const store of stores) expect(existsSync(store)).toBe(false);
    expect(readSourceRegistry(env).accounts).toEqual([]);
  });

  test('an unreadable registry: the worker cannot mark, so it refuses; the CLI removes the files anyway', () => {
    const { homeDir, env } = fixture();
    const stores = connectReadwise(env);
    writeFileSync(sourceRegistryPath(env), 'not json');
    expect(() => deleteOlympusData({ sourceId: 'readwise.library', homeDir, env, applyAtRestart: true })).toThrow('cannot be marked');
    for (const store of stores) expect(existsSync(store)).toBe(true);
    expect(() => deleteMarkedAccounts({ homeDir, env })).toThrow();

    deleteOlympusData({ sourceId: 'readwise.library', homeDir, env });
    for (const store of stores) expect(existsSync(store)).toBe(false);
  });

  test('Delete all takes the registry and the trash of a data folder outside the known roots', () => {
    const { dir, homeDir, env } = fixture();
    const moved = { ...env, XDG_DATA_HOME: join(dir, 'elsewhere-data') };
    connectReadwise(moved);
    const trashLeftover = put(join(accountTrashRoot(moved), 'stale', 'stores', 'internal.sqlite'));
    const registry = sourceRegistryPath(moved);
    expect(existsSync(registry)).toBe(true);

    const result = deleteOlympusData({ all: true, homeDir, env: moved });

    expect(result.removed).toEqual(expect.arrayContaining([registry, accountTrashRoot(moved)]));
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(trashLeftover)).toBe(false);
  });

  test('an export iterates the accounts that exist and records each one\'s layout', () => {
    const { homeDir, env } = fixture();
    connectReadwise(env);
    const result = exportOlympusData({ destination: join(homeDir, 'out'), homeDir, env });
    expect(result.sourceIds).toEqual(['readwise.library']);
    const manifest = JSON.parse(readFileSync(join(homeDir, 'out', 'manifest.json'), 'utf8'));
    expect(manifest.accounts).toEqual([{ source_id: 'readwise.library', slot: '1', layout: 'folder' }]);
  });
});

describe('data-lifecycle.ts knows no source', () => {
  const source = readFileSync(join(ROOT, 'src', 'data-lifecycle.ts'), 'utf8');
  const file = ts.createSourceFile('data-lifecycle.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  test('no string in its code names a source, an alias or a source\'s own file', () => {
    const ids = [...lifecycleSourceIds(), 'whatsapp.messages', 'telegram', 'whatsapp', 'dropbox', 'gmail', 'readwise', 'x-bookmarks', 'archive'];
    const named: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const text = node.text.toLowerCase();
        for (const id of ids) if (text.includes(id)) named.push(`${id} in ${JSON.stringify(node.text).slice(0, 80)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(named).toEqual([]);
  });

  test('it imports no connector\'s module', () => {
    const imports = file.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text)
      .filter((path) => path.startsWith('./workers/'));
    // Generic modules only: the tier sidecars, the credential broker's records.
    expect(imports.sort()).toEqual([
      './workers/classification/tier-ledger-path.ts',
      './workers/credential-broker/connected-handles.ts',
      './workers/credential-broker/unpaired-sources.ts',
    ]);
  });
});
