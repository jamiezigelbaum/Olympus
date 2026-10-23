// Review fixes for the local files connector: a chosen folder inside a place
// that is off by default keeps its live changes, one unreadable corner does not
// stop deletions elsewhere, paths are canonical, and listings fail closed.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, readdirSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetScopeSafeNativeForTests, scopeSafeNativeForTests } from '../src/core/scope-safe-fs.ts';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { defaultLocalFilesIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { LOCAL_FILES_CURSOR_PREFIX, createLocalFilesSourceConnector, localFilesItemId } from '../src/workers/local-files/connector.ts';
import {
  defaultExclusionContext,
  defaultExclusionForFolder,
  type DefaultExclusionContext,
} from '../src/workers/local-files/paths.ts';
import {
  createLocalFilesProviderStoreSyncHandler,
  type LocalFilesProviderStoreSyncHandler,
} from '../src/workers/local-files/provider-store-sync.ts';
import { createLocalFilesFolderScopeBrowser } from '../src/workers/local-files/scope-browser.ts';
import {
  decideLocalFilesPath,
  localFilesRoots,
  LOCAL_FILES_POLICY_SOURCE,
  type LocalFilesContentScope,
} from '../src/workers/local-files/scope.ts';
import {
  LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV,
  createLocalFilesConnectorStore,
} from '../src/workers/local-files/store.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { WatchHub, ignoreGlobsForRoot, watchIgnoreGlobs, type ParcelWatcherModule, type WatchEvent } from '../src/workers/local-files/watch-hub.ts';

type Selection = { key: string; state: 'ingest' | 'metadata_only' | 'exclude' };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  resetScopeSafeNativeForTests(undefined);
  while (cleanups.length) await cleanups.pop()!();
});

function fixture(select: (home: string) => string, platform: NodeJS.Platform = 'darwin') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'local-files-fix-')));
  const home = join(base, 'home');
  const chosen = select(home);
  mkdirSync(chosen, { recursive: true });
  const env = {
    [LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV]: join(base, 'store.sqlite'),
    [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(base, 'none.json'),
  };
  const store = createLocalFilesConnectorStore(env, { policy: defaultLocalFilesIngestionPolicy({ stillImagesRead: false }) });
  const selections: Selection[] = [{ key: chosen, state: 'ingest' }];
  const context: DefaultExclusionContext = { home, syncedRoots: [], platform };
  const approval = { selections, wholeAccount: false };
  const scope: LocalFilesContentScope = {
    generation: 'a'.repeat(64),
    revision: '11111111-2222-4333-8444-555555555555',
    assertCurrent() {},
    decide: (path) => decideLocalFilesPath({ selections, wholeAccount: false }, path, context),
    snapshotDecider: () => (path) => decideLocalFilesPath({ selections, wholeAccount: false }, path, context),
    roots: () => localFilesRoots(approval),
  };
  const snapshotDir = join(base, 'watch');
  mkdirSync(snapshotDir, { recursive: true });
  const hub = new WatchHub();
  const volumes = new VolumeResolver();
  cleanups.push(async () => { await hub.close(); store.close(); rmSync(base, { recursive: true, force: true }); });
  const handler = (options: { ignore?: readonly string[]; useHub?: boolean } = {}): LocalFilesProviderStoreSyncHandler =>
    createLocalFilesProviderStoreSyncHandler({
      store, scope, volumes, snapshotDir,
      ...(options.useHub === false ? {} : { hub }),
      ...(options.ignore ? { ignore: options.ignore } : {}),
    });
  const keyFor = (root: string): string => `${LOCAL_FILES_POLICY_SOURCE}:${root}`;
  return { base, home, chosen, store, scope, context, selections, hub, handler, keyFor, volumes };
}

const titles = (store: LocalConnectorStore, query: string): string[] =>
  store.searchItems(query, 50, 'this_computer').map((row) => String(row.title ?? '')).sort();
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1500));

describe('a chosen folder inside a place that is off by default keeps its live changes', () => {
  test('ignore globs drop only what would hide the chosen folder', () => {
    const context: DefaultExclusionContext = { home: '/Users/jo', syncedRoots: ['/Users/jo/Sync'], platform: 'darwin' };
    const globs = watchIgnoreGlobs(context);
    const icloud = '/Users/jo/Library/Mobile Documents/com~apple~CloudDocs';
    const forIcloud = ignoreGlobsForRoot(globs, icloud);
    expect(forIcloud).not.toContain('/Users/jo/Library');
    expect(forIcloud).toContain('/Users/jo/.olympus');
    expect(forIcloud).toContain('**/.git');
    expect(ignoreGlobsForRoot(globs, '/Users/jo/code/app/.git')).not.toContain('**/.git');
    expect(ignoreGlobsForRoot(globs, '/Users/jo/code/app')).toEqual(globs);
    expect(ignoreGlobsForRoot(globs, '/Users/jo/Sync/inner')).not.toContain('/Users/jo/Sync');
  });

  test('a deletion inside a chosen folder under Library is found by replay', async () => {
    const f = fixture((home) => join(home, 'Library', 'Docs'));
    if (!(await f.hub.available())) return;
    writeFileSync(join(f.chosen, 'keep.txt'), 'one');
    writeFileSync(join(f.chosen, 'remove.txt'), 'two');
    const ignore = watchIgnoreGlobs(f.context);
    const handler = f.handler({ ignore });
    const first = await handler.pull({ approved_scope_key: f.keyFor(f.chosen) });
    expect(titles(f.store, 'txt')).toEqual(['keep.txt', 'remove.txt']);
    rmSync(join(f.chosen, 'remove.txt'));
    writeFileSync(join(f.chosen, 'added.txt'), 'three');
    await settle();
    const second = await handler.pull({ approved_scope_key: f.keyFor(f.chosen), checkpoint: first.checkpoint! });
    expect(second.receipt.counts.full_listing).toBe(0);
    expect(titles(f.store, 'txt')).toEqual(['added.txt', 'keep.txt']);
  });
});

describe('one unreadable corner does not stop deletions elsewhere', () => {
  test('a locked folder keeps its items; a deleted file elsewhere is removed on a full walk', async () => {
    if (process.getuid?.() === 0) return;
    const f = fixture((home) => join(home, 'proj'));
    mkdirSync(join(f.chosen, 'locked'));
    writeFileSync(join(f.chosen, 'locked', 'inside.txt'), 'a');
    writeFileSync(join(f.chosen, 'gone.txt'), 'b');
    writeFileSync(join(f.chosen, 'stays.txt'), 'c');
    const handler = f.handler({ useHub: false });
    await handler.pull({ approved_scope_key: f.keyFor(f.chosen) });
    chmodSync(join(f.chosen, 'locked'), 0o000);
    cleanups.push(() => { try { chmodSync(join(f.chosen, 'locked'), 0o755); } catch { /* gone */ } });
    rmSync(join(f.chosen, 'gone.txt'));
    const second = await handler.pull({ approved_scope_key: f.keyFor(f.chosen) });
    expect(second.receipt.counts.unreadable_folders).toBe(1);
    expect(second.receipt.counts.traversal_complete).toBe(1);
    expect(titles(f.store, 'txt')).toEqual(['inside.txt', 'stays.txt']);
  });

  test('a file nobody may read is still listed by name', async () => {
    if (process.getuid?.() === 0) return;
    const f = fixture((home) => join(home, 'proj'));
    writeFileSync(join(f.chosen, 'sealed.txt'), 'x');
    chmodSync(join(f.chosen, 'sealed.txt'), 0o000);
    cleanups.push(() => { try { chmodSync(join(f.chosen, 'sealed.txt'), 0o644); } catch { /* gone */ } });
    const result = await f.handler({ useHub: false }).pull({ approved_scope_key: f.keyFor(f.chosen) });
    expect(result.receipt.counts.unreadable_folders).toBe(0);
    expect(titles(f.store, 'sealed')).toEqual(['sealed.txt']);
  });

  test('a walk of the whole computer still removes what vanished', async () => {
    const f = fixture((home) => join(home, 'proj'));
    writeFileSync(join(f.chosen, 'stays.txt'), 'a');
    writeFileSync(join(f.chosen, 'vanishes.txt'), 'b');
    const handler = f.handler({ useHub: false });
    await handler.pull({ approved_scope_key: f.keyFor('/') });
    expect(titles(f.store, 'txt')).toEqual(['stays.txt', 'vanishes.txt']);
    rmSync(join(f.chosen, 'vanishes.txt'));
    await handler.pull({ approved_scope_key: f.keyFor('/') });
    expect(titles(f.store, 'txt')).toEqual(['stays.txt']);
  });

  test('a complete walk on a case-keeping volume does not remove a case-only sibling root', async () => {
    const f = fixture((home) => join(home, 'proj'));
    writeFileSync(join(f.chosen, 'here.txt'), 'a');
    const sibling = join(f.home, 'PROJ');
    const at = (locatorUri: string) => {
      const providerItemId = localFilesItemId(locatorUri);
      return {
        identity: {
          family: 'file' as const, provider: 'local_files', accountScope: 'this_computer',
          providerItemId, localItemId: `this_computer:${providerItemId}`,
        },
        locatorUri,
      };
    };
    // The store's range folds ASCII case, so it also returns the sibling root's rows.
    const rows = [at(`${sibling}/other.txt`), at(join(f.chosen, 'vanished.txt'))];
    const connector = createLocalFilesSourceConnector({
      connectorId: 'walk',
      root: f.chosen,
      scope: f.scope,
      volumes: f.volumes,
      store: {
        activeIdentityForLocatorIfIndexed: () => undefined,
        activeItemsUnderLocatorIfIndexed: (input: { limit: number }) => rows.slice(0, input.limit),
      },
    });
    const items = [];
    for await (const page of connector.listItems({})) items.push(...page.items);
    expect(items.filter((item) => item.metadata['deleted'] === true).map((item) => item.metadata['locatorUri']))
      .toEqual([join(f.chosen, 'vanished.txt')]);
  });

  test('a listing that fails part way is not taken as complete', async () => {
    const f = fixture((home) => join(home, 'proj'));
    writeFileSync(join(f.chosen, 'a.txt'), '1');
    const handler = f.handler({ useHub: false });
    await handler.pull({ approved_scope_key: f.keyFor(f.chosen) });
    const native = scopeSafeNativeForTests();
    if (!native) return;
    resetScopeSafeNativeForTests({
      ...native,
      readdirNames: () => { throw new (class extends Error { code = 'io'; })('readdir errno 5'); },
    });
    rmSync(join(f.chosen, 'a.txt'));
    await handler.pull({ approved_scope_key: f.keyFor(f.chosen) }).catch(() => undefined);
    resetScopeSafeNativeForTests(undefined);
    expect(titles(f.store, 'txt')).toEqual(['a.txt']);
  });
});

describe('paths are canonical', () => {
  test('the exclusion context uses the real home, so a linked home still matches', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'local-files-home-')));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(base, 'real', 'u'), { recursive: true });
    symlinkSync(join(base, 'real'), join(base, 'link'));
    const context = defaultExclusionContext({ HOME: join(base, 'link', 'u') });
    expect(context.home).toBe(join(base, 'real', 'u'));
    expect(defaultExclusionForFolder(`${context.home}/.openclaw`, { ...context, platform: 'linux' })).toBe('olympus_data');
  });

  test('on a Mac the default-off folders match without regard to case', () => {
    const darwin: DefaultExclusionContext = { home: '/Users/jo', syncedRoots: ['/Users/jo/Sync'], platform: 'darwin' };
    expect(defaultExclusionForFolder('/Users/jo/library', darwin)).toBe('system_library');
    expect(defaultExclusionForFolder('/Users/JO/.OpenClaw', { ...darwin, home: '/Users/JO' })).toBe('olympus_data');
    expect(defaultExclusionForFolder('/users/jo/dropbox', darwin)).toBe('synced_by_another_source');
    expect(defaultExclusionForFolder('/Users/jo/sync', darwin)).toBe('synced_by_another_source');
    const linux: DefaultExclusionContext = { home: '/home/jo', syncedRoots: [], platform: 'linux' };
    expect(defaultExclusionForFolder('/home/jo/library', linux)).toBeUndefined();
  });

  test('a selection through a link is refused and a case-different spelling is rewritten', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'local-files-pick-')));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const homeDir = join(base, 'Home');
    mkdirSync(join(homeDir, 'Docs'), { recursive: true });
    symlinkSync(homeDir, join(base, 'alias'));
    const browser = createLocalFilesFolderScopeBrowser({
      volumes: new VolumeResolver(), home: homeDir, context: { home: homeDir, syncedRoots: [], platform: process.platform },
    });
    await expect(browser.validateSelections([{ key: join(base, 'alias', 'Docs'), state: 'ingest' }])).rejects.toThrow(/link/);
    if (existsSync(join(base, 'home', 'docs'))) {
      const checked = await browser.validateSelections([{ key: join(base, 'home', 'docs'), state: 'ingest' }]);
      expect(checked.map((entry) => entry.key)).toEqual([join(homeDir, 'Docs')]);
    }
    const ok = await browser.validateSelections([{ key: join(homeDir, 'Docs'), state: 'ingest' }]);
    expect(ok.map((entry) => entry.key)).toEqual([join(homeDir, 'Docs')]);
  });

  test('a decomposed file name is indexed under its composed path and still opens', async () => {
    const f = fixture((home) => join(home, 'proj'));
    const nfd = 'Café menu.txt';
    writeFileSync(join(f.chosen, nfd), 'espresso');
    await f.handler({ useHub: false }).pull({ approved_scope_key: f.keyFor(f.chosen) });
    const row = f.store.searchItems('menu', 10, 'this_computer')[0]!;
    const composedPath = join(f.chosen, nfd).normalize('NFC');
    expect(row.sourceItem.providerItemId).toBe(localFilesItemId(composedPath));
    const connector = createLocalFilesSourceConnector({
      connectorId: 'nfc', root: f.chosen, scope: f.scope, volumes: f.volumes,
      locate: (id) => (id === row.sourceItem.localItemId ? composedPath : undefined),
    });
    const read = await connector.fetchItemWithin(row.sourceItem.localItemId, {});
    expect(read.content.kind === 'bytes' ? Buffer.from(read.content.bytes).toString() : '').toBe('espresso');
  });
});

describe('replay', () => {
  /** A watcher module that reports fixed events and writes empty snapshot files. */
  const fakeHub = (events: (dir: string) => WatchEvent[]): WatchHub => new WatchHub({
    load: async (): Promise<ParcelWatcherModule> => ({
      subscribe: async () => ({ unsubscribe: async () => undefined }),
      writeSnapshot: async (_dir, snapshotPath) => { writeFileSync(snapshotPath, 'snap'); return snapshotPath; },
      getEventsSince: async (dir) => events(dir),
    }),
  });

  async function replay(options: {
    f: ReturnType<typeof fixture>;
    root: string;
    hub: WatchHub;
    store?: Parameters<typeof createLocalFilesSourceConnector>[0]['store'];
    deletedDescendantBatch?: number;
  }) {
    writeFileSync(join(options.f.base, 'watch', 'rp.prior.snap'), 'snap');
    const connector = createLocalFilesSourceConnector({
      connectorId: 'rp',
      root: options.root,
      scope: options.f.scope,
      volumes: options.f.volumes,
      ...(options.store ? { store: options.store } : {}),
      ...(options.deletedDescendantBatch ? { deletedDescendantBatch: options.deletedDescendantBatch } : {}),
      watch: { hub: options.hub, snapshotDir: join(options.f.base, 'watch') },
    });
    const items = [];
    for await (const page of connector.listItems({ cursor: `${LOCAL_FILES_CURSOR_PREFIX}prior` })) items.push(...page.items);
    return items;
  }

  test('a watcher event is not dropped when the whole computer is the root', async () => {
    const f = fixture((home) => join(home, 'proj'));
    writeFileSync(join(f.chosen, 'fresh.txt'), 'new');
    const hub = fakeHub(() => [{ type: 'create', path: join(f.chosen, 'fresh.txt') }]);
    cleanups.push(() => hub.close());
    const items = await replay({ f, root: '/', hub });
    expect(items.map((item) => item.metadata['name'])).toEqual(['fresh.txt']);
  });

  test('a skipped folder renamed to another case is not replayed in', async () => {
    const f = fixture((home) => join(home, 'proj'));
    f.selections.push({ key: join(f.chosen, 'Private'), state: 'exclude' });
    mkdirSync(join(f.chosen, 'private'), { recursive: true });
    writeFileSync(join(f.chosen, 'private', 'a.txt'), 'secret');
    writeFileSync(join(f.chosen, 'open.txt'), 'fine');
    const hub = fakeHub(() => [
      { type: 'create', path: join(f.chosen, 'private', 'a.txt') },
      { type: 'create', path: join(f.chosen, 'open.txt') },
    ]);
    cleanups.push(() => hub.close());
    const items = await replay({ f, root: f.chosen, hub });
    expect(items.map((item) => item.metadata['name'])).toEqual(['open.txt']);
  });

  test('a deleted folder with more indexed files than one lookup returns loses all of them', async () => {
    const f = fixture((home) => join(home, 'proj'));
    const gone = join(f.chosen, 'gone');
    const rows = Array.from({ length: 7 }, (_, index) => {
      const locatorUri = `${gone}/file-${index}.txt`;
      const providerItemId = localFilesItemId(locatorUri);
      return {
        identity: {
          family: 'file' as const, provider: 'local_files', accountScope: 'this_computer',
          providerItemId, localItemId: `this_computer:${providerItemId}`,
        },
        locatorUri,
      };
    });
    // Like the real store: the same leading rows every time, because nothing is committed yet.
    const store = {
      activeIdentityForLocatorIfIndexed: () => undefined,
      activeItemsUnderLocatorIfIndexed: (input: { limit: number }) => rows.slice(0, input.limit),
    };
    const hub = fakeHub(() => [{ type: 'delete', path: gone }]);
    cleanups.push(() => hub.close());
    const items = await replay({ f, root: f.chosen, hub, store, deletedDescendantBatch: 3 });
    expect(items.filter((item) => item.metadata['deleted'] === true).length).toBe(7);
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(7);
    expect(readdirSync(join(f.base, 'watch')).length).toBeGreaterThan(0);
  });

  // The store's locator range ignores ASCII case; on a volume that keeps case
  // `/gone` and `/Gone` are two folders, so deleting one keeps the other.
  const rowAt = (locatorUri: string) => {
    const providerItemId = localFilesItemId(locatorUri);
    return {
      identity: {
        family: 'file' as const, provider: 'local_files', accountScope: 'this_computer',
        providerItemId, localItemId: `this_computer:${providerItemId}`,
      },
      locatorUri,
    };
  };

  test('a deleted folder on a case-keeping volume leaves its case-only sibling indexed', async () => {
    const f = fixture((home) => join(home, 'proj'));
    const gone = join(f.chosen, 'gone');
    const sibling = join(f.chosen, 'Gone');
    const rows = [rowAt(`${sibling}/kept.txt`), rowAt(`${gone}/removed.txt`)];
    const store = {
      // Folded like the store: the sibling's identity answers for `gone`.
      activeIdentityForLocatorIfIndexed: () => rowAt(sibling).identity,
      activeItemsUnderLocatorIfIndexed: (input: { limit: number }) => rows.slice(0, input.limit),
    };
    const hub = fakeHub(() => [{ type: 'delete', path: gone }]);
    cleanups.push(() => hub.close());
    const items = await replay({ f, root: f.chosen, hub, store, deletedDescendantBatch: 1 });
    expect(items.filter((item) => item.metadata['deleted'] === true).map((item) => item.metadata['locatorUri']))
      .toEqual([`${gone}/removed.txt`]);
  });
});
