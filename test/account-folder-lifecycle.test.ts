// Delete, reconnect, Delete all and Export for an account that lives in its
// own folder (docs/design/source-storage.md, delivery step 4a). The folder is
// the account's whole footprint: Delete takes it whole and nothing beside it;
// Export copies the stores and never `raw/` or `session/`.
// Spawning tests carry an explicit timeout (test/spawn-timeout-guard.test.ts).

import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { holdDataOwnerLock, isDataOwnerLockName, type HeldDataOwnerLock } from '../src/core/data-owner-lock.ts';
import { accountFolder, FOLDER_LAYOUT_SOURCES, olympusDataRoot } from '../src/core/olympus-layout.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { resolvedStorePath } from '../src/core/source-placement.ts';
import { readSourceRegistry, updateSourceRegistry } from '../src/core/source-registry.ts';
import { __sourceStorageTestHooks, enableSourceRegistryAdoption, openConnectorStore } from '../src/core/source-storage.ts';
import { deleteOlympusData, exportOlympusData, verifyOlympusDataExport } from '../src/data-lifecycle.ts';
import { createReadwiseConnectorStore, defaultReadwiseConnectorStoreDbPath } from '../src/workers/readwise/connector.ts';
import { defaultReadwiseSecureConnectorStoreDbPath } from '../src/workers/readwise/tier-set.ts';
import { createXBookmarksConnectorStore, defaultXBookmarksConnectorStoreDbPath } from '../src/workers/x-bookmarks/connector.ts';
import { defaultXBookmarksApiUsageDbPath } from '../src/workers/x-bookmarks/live-control.ts';

type Env = Record<string, string>;

const roots: string[] = [];
const held: HeldDataOwnerLock[] = [];
afterEach(() => {
  __sourceStorageTestHooks.disableAdoption();
  for (const lock of held.splice(0)) lock.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { dataHome?: string } = {}): { dir: string; homeDir: string; env: Env } {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-account-folders-'));
  roots.push(dir);
  const homeDir = join(dir, 'home');
  return {
    dir,
    homeDir,
    env: {
      HOME: homeDir,
      XDG_DATA_HOME: options.dataHome ? join(dir, options.dataHome) : join(homeDir, '.local', 'share'),
      XDG_STATE_HOME: join(homeDir, '.local', 'state'),
      PATH: process.env.PATH ?? '',
    },
  };
}

function put(path: string, text = 'x'): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A connected Readwise (two tiers), as the worker opens it. */
function connectReadwise(env: Env): string[] {
  enableSourceRegistryAdoption();
  const internal = createReadwiseConnectorStore(defaultReadwiseConnectorStoreDbPath(env), env);
  internal.close();
  const secureDb = defaultReadwiseSecureConnectorStoreDbPath(env);
  openConnectorStore({ sourceId: 'readwise.library' }, {
    dbPath: secureDb,
    corpusId: 'secure_local.readwise.library',
    family: 'readwise',
    trustDomain: 'secure_local',
  }, env).close();
  return [defaultReadwiseConnectorStoreDbPath(env), secureDb];
}

/** A connected Readwise (two tiers) and X, as the worker opens them. */
function connect(env: Env): { readwise: string[]; x: string } {
  const readwise = connectReadwise(env);
  const xDb = defaultXBookmarksConnectorStoreDbPath(env);
  createXBookmarksConnectorStore(xDb, env).close();
  return { readwise, x: xDb };
}

/** Every path under a folder with what it holds (links by their target), to prove a refusal changed nothing. */
function snapshot(root: string): Record<string, string> {
  const seen: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) seen[path] = `-> ${readlinkSync(path)}`;
      else if (entry.isDirectory()) {
        seen[path] = 'dir';
        walk(path);
      } else seen[path] = readFileSync(path).toString('base64');
    }
  };
  walk(root);
  return seen;
}

const readwiseFolder = (env: Env): string => accountFolder({ source_id: 'readwise.library', slot: '1' }, env);
const xFolder = (env: Env): string => accountFolder({ source_id: 'x.bookmarks', slot: '1' }, env);

function everyFile(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? everyFile(path) : [path];
  });
}

describe('Delete of one folder account', () => {
  test('takes its stores and the whole folder, nothing beside it, and keeps the registry entry', () => {
    const { homeDir, env } = fixture();
    const stores = connect(env);
    const usage = put(defaultXBookmarksApiUsageDbPath(env));
    put(join(readwiseFolder(env), 'raw', 'notes.txt'));
    put(join(readwiseFolder(env), 'session', 'token.txt'));
    put(join(xFolder(env), 'raw', 'x-reconcile.sqlite'));
    for (const store of stores.readwise) expect(existsSync(store)).toBe(true);

    const preview = deleteOlympusData({ sourceId: 'readwise.library', homeDir, env, dryRun: true });
    expect(preview.removed).toEqual(expect.arrayContaining([...stores.readwise, readwiseFolder(env)]));
    expect(existsSync(readwiseFolder(env))).toBe(true);

    const result = deleteOlympusData({ sourceId: 'readwise.library', homeDir, env });

    expect(result.removed).toEqual(expect.arrayContaining([...stores.readwise, readwiseFolder(env)]));
    expect(existsSync(readwiseFolder(env))).toBe(false);
    // Another account is untouched, with its raw state; the shared X usage ledger is not Readwise's anyway.
    expect(existsSync(stores.x)).toBe(true);
    expect(existsSync(join(xFolder(env), 'raw', 'x-reconcile.sqlite'))).toBe(true);
    // The registry (step 2 and 3 behavior) still lists the account; the Delete's state markers are step 5's.
    const registry = readSourceRegistry(env);
    expect(registry.schema).toBe(2);
    expect(registry.accounts.map((account) => [account.source_id, account.state, account.layout])).toEqual([
      ['readwise.library', 'active', 'folder'],
      ['x.bookmarks', 'active', 'folder'],
    ]);

    // Deleting X keeps its quota ledger, which is shared and not in its folder.
    deleteOlympusData({ sourceId: 'x.bookmarks', homeDir, env });
    expect(existsSync(xFolder(env))).toBe(false);
    expect(existsSync(usage)).toBe(true);
  });

  test('a Delete of an account with no folder (never connected) removes nothing and does not fail', () => {
    const { homeDir, env } = fixture();
    const result = deleteOlympusData({ sourceId: 'readwise.library', homeDir, env });
    expect(result.removed).toEqual([]);
    expect(existsSync(olympusDataRoot(env))).toBe(false);
  });

  test('reconnecting places the account in the same folder again', () => {
    const { homeDir, env } = fixture();
    const first = connect(env);
    deleteOlympusData({ sourceId: 'readwise.library', homeDir, env });
    expect(existsSync(readwiseFolder(env))).toBe(false);

    const again = connect(env);

    expect(again.readwise).toEqual(first.readwise);
    for (const store of again.readwise) expect(existsSync(store)).toBe(true);
    expect(dirname(dirname(again.readwise[0]!))).toBe(readwiseFolder(env));
    expect(readSourceRegistry(env).accounts.filter((account) => account.source_id === 'readwise.library')).toHaveLength(1);
  });

  test('an account recorded legacy stays legacy through Delete and reconnect', () => {
    const { homeDir, env } = fixture();
    const legacy = join(olympusDataRoot(env), 'readwise-connector-store.sqlite');
    put(legacy, 'indexed');
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push({ source_id: 'readwise.library', slot: '1', state: 'active', layout: 'legacy', corpus_ids: [], created_at: '2026-10-24T00:00:00.000Z' });
    });
    const result = deleteOlympusData({ sourceId: 'readwise.library', homeDir, env });
    expect(result.removed).toContain(legacy);
    expect(existsSync(legacy)).toBe(false);

    enableSourceRegistryAdoption();
    expect(defaultReadwiseConnectorStoreDbPath(env)).toBe(legacy);
    createReadwiseConnectorStore(defaultReadwiseConnectorStoreDbPath(env), env).close();
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(olympusDataRoot(env), 'sources'))).toBe(false);
    expect(readSourceRegistry(env).accounts[0]?.layout).toBe('legacy');
  });

  test('a folder reached through a link is refused before anything is removed', () => {
    const { homeDir, env, dir } = fixture();
    const victim = join(dir, 'victim');
    put(join(victim, 'precious.txt'), 'mine');
    // The account folder itself is a link.
    mkdirSync(dirname(readwiseFolder(env)), { recursive: true });
    symlinkSync(victim, readwiseFolder(env));
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push({ source_id: 'readwise.library', slot: '1', state: 'active', layout: 'folder', corpus_ids: [], created_at: '2026-10-24T00:00:00.000Z' });
    });
    expect(() => deleteOlympusData({ sourceId: 'readwise.library', homeDir, env })).toThrow(OperationError);
    expect(readFileSync(join(victim, 'precious.txt'), 'utf8')).toBe('mine');

    // A link higher up, in the source's folder.
    rmSync(readwiseFolder(env));
    rmSync(dirname(readwiseFolder(env)), { recursive: true });
    mkdirSync(join(victim, '1'), { recursive: true });
    put(join(victim, '1', 'stores', 'internal.sqlite'), 'mine too');
    symlinkSync(victim, dirname(readwiseFolder(env)));
    expect(() => deleteOlympusData({ sourceId: 'readwise.library', homeDir, env })).toThrow(/symbolic link/);
    expect(readFileSync(join(victim, '1', 'stores', 'internal.sqlite'), 'utf8')).toBe('mine too');
  });
});

describe('Delete never reaches into another account', () => {
  test('a stores folder linked to another account is refused, and the other account keeps every file', () => {
    const { homeDir, env } = fixture();
    const stores = connect(env);
    // X holds files named as Readwise's databases, ledgers and sidecars are.
    const xStores = dirname(stores.x);
    const readwiseStores = join(readwiseFolder(env), 'stores');
    for (const name of readdirSync(readwiseStores)) copyFileSync(join(readwiseStores, name), join(xStores, name));
    put(join(xStores, 'internal.sqlite-wal'), 'x wal');
    put(join(xStores, 'internal.sqlite-shm'), 'x shm');
    // Readwise's own stores folder is now a link to X's.
    rmSync(readwiseStores, { recursive: true });
    symlinkSync(xStores, readwiseStores);
    const before = snapshot(olympusDataRoot(env));
    expect(Object.keys(before).filter((path) => path.startsWith(`${xStores}/`)).length).toBeGreaterThanOrEqual(stores.readwise.length + 1);

    expect(() => deleteOlympusData({ sourceId: 'readwise.library', homeDir, env })).toThrow(/symbolic link/);
    expect(() => deleteOlympusData({ sourceId: 'readwise.library', homeDir, env, dryRun: true })).toThrow(/symbolic link/);

    // Nothing was deleted: X's files, Readwise's folder and the link are as they were.
    expect(snapshot(olympusDataRoot(env))).toEqual(before);
    expect(readlinkSync(readwiseStores)).toBe(xStores);
  });

  test('a store that is itself a link into another account is refused', () => {
    const { homeDir, env } = fixture();
    const stores = connect(env);
    const [internal] = stores.readwise as [string, string];
    const xOwned = put(join(dirname(stores.x), 'internal.sqlite'), 'x owns this');
    rmSync(internal);
    symlinkSync(xOwned, internal);
    const before = snapshot(olympusDataRoot(env));

    expect(() => deleteOlympusData({ sourceId: 'readwise.library', homeDir, env })).toThrow(/symbolic link/);

    expect(snapshot(olympusDataRoot(env))).toEqual(before);
    expect(readFileSync(xOwned, 'utf8')).toBe('x owns this');
  });

  test('Delete all refuses a linked stores folder too, with every file in place', () => {
    const { homeDir, env, dir } = fixture();
    connect(env);
    const outside = join(dir, 'outside');
    put(join(outside, 'precious.txt'), 'mine');
    const readwiseStores = join(readwiseFolder(env), 'stores');
    rmSync(readwiseStores, { recursive: true });
    symlinkSync(outside, readwiseStores);
    const before = snapshot(olympusDataRoot(env));

    expect(() => deleteOlympusData({ all: true, homeDir, env })).toThrow(/symbolic link/);

    expect(snapshot(olympusDataRoot(env))).toEqual(before);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('mine');
  });

  // The legacy account's retained override: `OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_DB_PATH`
  // names a file inside Readwise's folder. Removing Readwise's folder whole would take X's store.
  test('a legacy account whose retained override points inside the folder keeps its store, and the delete is refused naming it', () => {
    const { homeDir, env: base } = fixture();
    const stores = connectReadwise(base);
    __sourceStorageTestHooks.disableAdoption();
    const xStore = join(readwiseFolder(base), 'stores', 'x.sqlite');
    const env = { ...base, OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_DB_PATH: xStore };
    createXBookmarksConnectorStore(defaultXBookmarksConnectorStoreDbPath(env), env).close();
    expect(defaultXBookmarksConnectorStoreDbPath(env)).toBe(xStore);
    expect(existsSync(xStore)).toBe(true);
    const before = snapshot(olympusDataRoot(env));

    let message = '';
    try {
      deleteOlympusData({ sourceId: 'readwise.library', homeDir, env });
    } catch (error) {
      message = error instanceof OperationError ? `${error.message}\n${error.suggestion ?? ''}` : String(error);
    }

    expect(message).toContain('overlaps another source');
    expect(message).toContain(xStore);
    expect(message).toContain(readwiseFolder(env));
    expect(snapshot(olympusDataRoot(env))).toEqual(before);
    for (const store of stores) expect(existsSync(store)).toBe(true);
    expect(() => deleteOlympusData({ sourceId: 'readwise.library', homeDir, env, dryRun: true })).toThrow(/overlaps another source/);
    // Deleting the account that owns the override takes its store and leaves the folder that holds it.
    deleteOlympusData({ sourceId: 'x.bookmarks', homeDir, env });
    expect(existsSync(xStore)).toBe(false);
    for (const store of stores) expect(existsSync(store)).toBe(true);
  });

  test('every account folder deletes cleanly beside the others, so the overlap rule never refuses a normal install', () => {
    const { homeDir, env } = fixture();
    for (const sourceId of FOLDER_LAYOUT_SOURCES) put(join(accountFolder({ source_id: sourceId, slot: '1' }, env), 'raw', 'note.txt'));
    for (const sourceId of FOLDER_LAYOUT_SOURCES) {
      const folder = accountFolder({ source_id: sourceId, slot: '1' }, env);
      const preview = deleteOlympusData({ sourceId, homeDir, env, dryRun: true });
      expect(preview.removed).toContain(folder);
    }
  });
});

describe('Delete all', () => {
  test('removes every account folder in a relocated data root, keeps the lock file, and still holds it', async () => {
    const { homeDir, env } = fixture({ dataHome: 'elsewhere' });
    const lock = holdDataOwnerLock(env);
    held.push(lock);
    const dataRoot = olympusDataRoot(env);
    expect(dataRoot.startsWith(join(homeDir, '.local'))).toBe(false);
    connect(env);
    put(join(readwiseFolder(env), 'raw', 'notes.txt'));
    put(join(dataRoot, 'unrelated-future-account', 'file'));
    put(join(dataRoot, 'sources', 'some.future.source', '1', 'stores', 'internal.sqlite'));

    const preview = deleteOlympusData({ all: true, homeDir, env, dryRun: true });
    expect(preview.removed).toContain(join(dataRoot, 'sources'));
    expect(existsSync(readwiseFolder(env))).toBe(true);

    const result = deleteOlympusData({ all: true, homeDir, env });

    expect(result.removed).toContain(join(dataRoot, 'sources'));
    expect(existsSync(join(dataRoot, 'sources'))).toBe(false);
    expect(existsSync(lock.lockPath)).toBe(true);
    expect(readdirSync(dataRoot).filter((name) => !isDataOwnerLockName(name)).sort()).toEqual([
      'registry.json',
      'registry.json.lock.db',
      'unrelated-future-account',
    ].filter((name) => existsSync(join(dataRoot, name))).sort());
    // The lock is still held by this process: another cannot take it.
    expect(await otherProcessSees(env)).toBe('BUSY');
  }, 60_000);

  test('in the default data root the folders go with the root and the lock file stays', () => {
    const { homeDir, env } = fixture();
    const lock = holdDataOwnerLock(env);
    held.push(lock);
    connect(env);
    deleteOlympusData({ all: true, homeDir, env });
    const dataRoot = olympusDataRoot(env);
    expect(readdirSync(dataRoot).every(isDataOwnerLockName)).toBe(true);
    expect(existsSync(join(dataRoot, 'sources'))).toBe(false);
  });
});

describe('Export of a folder account', () => {
  test('copies its stores and names, but never copies, raw/ and session/', () => {
    const { dir, homeDir, env } = fixture();
    const stores = connect(env);
    put(join(readwiseFolder(env), 'raw', 'notes.txt'), 'raw note');
    put(join(readwiseFolder(env), 'session', 'token.txt'), 'session secret');

    const destination = join(dir, 'export');
    const result = exportOlympusData({ destination, sourceId: 'readwise.library', homeDir, env });

    for (const store of stores.readwise) {
      expect(result.files.some((file) => file.endsWith(`/sources/readwise.library/${store.slice(store.lastIndexOf('/') + 1)}`))).toBe(true);
    }
    expect(result.skipped).toEqual(expect.arrayContaining([join(readwiseFolder(env), 'raw'), join(readwiseFolder(env), 'session')]));
    const copied = everyFile(destination);
    expect(copied.some((path) => path.endsWith('notes.txt') || path.endsWith('token.txt'))).toBe(false);
    expect(copied.some((path) => readFileSync(path).includes('session secret'))).toBe(false);
    expect(verifyOlympusDataExport({ destination }).ok).toBe(true);
    // Reading the folder changed nothing in it.
    expect(lstatSync(join(readwiseFolder(env), 'session', 'token.txt')).isFile()).toBe(true);
  });

  test('a full export includes every folder account', () => {
    const { dir, homeDir, env } = fixture();
    connect(env);
    const result = exportOlympusData({ destination: join(dir, 'export'), homeDir, env });
    expect(result.files.filter((file) => file.includes('/sources/readwise.library/')).length).toBe(2);
    expect(result.files.filter((file) => file.includes('/sources/x.bookmarks/')).length).toBe(1);
  });
});

const MODULE = join(import.meta.dir, '..', 'src', 'core', 'data-owner-lock.ts');

/** Whether another process can take the lock: it tries once, and says which. */
async function otherProcessSees(env: Env): Promise<'BUSY' | 'FREE'> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-account-folders-probe-'));
  roots.push(dir);
  const script = join(dir, 'probe.mts');
  await Bun.write(script, `
import { tryDataOwnerLock } from ${JSON.stringify(MODULE)};
const lock = tryDataOwnerLock(process.env);
process.stdout.write(lock ? 'FREE' : 'BUSY');
lock?.release();
`);
  const child = Bun.spawn([process.execPath, script], { env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`probe failed: ${err}`);
  return out as 'BUSY' | 'FREE';
}

// A store path resolved without a registry entry is the folder one (the same answer the worker records).
test('the resolver and the folder agree before the first open', () => {
  const { env } = fixture();
  expect(resolvedStorePath('readwise.library', 'internal', env)).toBe(join(readwiseFolder(env), 'stores', 'internal.sqlite'));
});
