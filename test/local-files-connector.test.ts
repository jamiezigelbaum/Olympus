import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetScopeSafeNativeForTests, scopeSafeNativeForTests } from '../src/core/scope-safe-fs.ts';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { defaultLocalFilesIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  createLocalFilesSourceConnector,
  LOCAL_FILES_POLL_CURSOR,
  localFilesItemId,
} from '../src/workers/local-files/connector.ts';
import { defaultExclusionContext, type DefaultExclusionContext } from '../src/workers/local-files/paths.ts';
import {
  createLocalFilesProviderStoreSyncHandler,
  type LocalFilesProviderStoreSyncHandler,
} from '../src/workers/local-files/provider-store-sync.ts';
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
import { WatchHub } from '../src/workers/local-files/watch-hub.ts';

type Selection = { key: string; state: 'ingest' | 'metadata_only' | 'exclude' };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  resetScopeSafeNativeForTests(undefined);
  while (cleanups.length) await cleanups.pop()!();
});

interface Fixture {
  base: string;
  home: string;
  proj: string;
  store: LocalConnectorStore;
  scope: LocalFilesContentScope;
  context: DefaultExclusionContext;
  selections: Selection[];
  handler: (hub?: WatchHub | null) => LocalFilesProviderStoreSyncHandler;
  approvedKey: string;
  hub: WatchHub;
  snapshotDir: string;
}

function fixture(selectionFor: (proj: string) => Selection[] = (proj) => [{ key: proj, state: 'ingest' }]): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'local-files-')));
  const home = join(base, 'home');
  const proj = join(home, 'proj');
  mkdirSync(proj, { recursive: true });
  const env = {
    [LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV]: join(base, 'store.sqlite'),
    [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(base, 'no-exclusions.json'),
  };
  const store = createLocalFilesConnectorStore(env, { policy: defaultLocalFilesIngestionPolicy({ stillImagesRead: false }) });
  const selections = selectionFor(proj);
  const context: DefaultExclusionContext = { ...defaultExclusionContext({}), home, syncedRoots: [] };
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
  cleanups.push(async () => {
    await hub.close();
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  return {
    base, home, proj, store, scope, context, selections, hub, snapshotDir,
    approvedKey: `${LOCAL_FILES_POLICY_SOURCE}:${proj}`,
    handler: (useHub: WatchHub | null = hub) => createLocalFilesProviderStoreSyncHandler({
      store,
      scope,
      volumes,
      snapshotDir,
      ...(useHub ? { hub: useHub } : {}),
      pageSize: 3,
    }),
  };
}

/** The operating system reports file changes a moment after they happen. */
const settleFileEvents = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1500));

function names(store: LocalConnectorStore, query: string): string[] {
  return store.searchItems(query, 50, 'this_computer').map((row) => String(row.title ?? '')).sort();
}

describe('scope decisions', () => {
  const context: DefaultExclusionContext = { home: '/Users/jo', syncedRoots: [], platform: 'darwin' };
  const sel = (key: string, state: Selection['state'] = 'ingest'): Selection => ({ key, state });

  test('nothing is selected by default', () => {
    expect(decideLocalFilesPath({ selections: [], wholeAccount: false }, '/Users/jo/Code/a.txt', context)).toBe('denied');
  });

  test('a selected folder covers what is under it; the nearest exclude wins', () => {
    const approval = { selections: [sel('/Users/jo/Code'), sel('/Users/jo/Code/private', 'exclude')], wholeAccount: false };
    expect(decideLocalFilesPath(approval, '/Users/jo/Code/a.txt', context)).toBe('content');
    expect(decideLocalFilesPath(approval, '/Users/jo/Code/private/b.txt', context)).toBe('denied');
    expect(decideLocalFilesPath(approval, '/Users/jo/Other/c.txt', context)).toBe('denied');
  });

  test('a metadata-only folder keeps content unread', () => {
    const approval = { selections: [sel('/Users/jo/Code', 'metadata_only')], wholeAccount: false };
    expect(decideLocalFilesPath(approval, '/Users/jo/Code/a.txt', context)).toBe('metadata');
  });

  test('folders that are off by default stay off under a selection above them', () => {
    const approval = { selections: [sel('/Users/jo')], wholeAccount: false };
    for (const path of [
      '/Users/jo/Library/Mail/x.emlx',
      '/Users/jo/Code/.git/config',
      '/Users/jo/Code/app/node_modules/pkg/index.js',
      '/Users/jo/.Trash/old.txt',
      '/Users/jo/Applications/Thing.app/Contents/Info.plist',
      '/Users/jo/Dropbox/notes.txt',
      '/Users/jo/Code/app/dist/bundle.js',
    ]) expect(decideLocalFilesPath(approval, path, context)).toBe('denied');
    expect(decideLocalFilesPath(approval, '/Users/jo/Documents/a.txt', context)).toBe('content');
  });

  test('turning one back on is an explicit selection of that folder or below it', () => {
    const approval = {
      selections: [sel('/Users/jo'), sel('/Users/jo/Library/Mobile Documents')],
      wholeAccount: false,
    };
    expect(decideLocalFilesPath(approval, '/Users/jo/Library/Mobile Documents/a.txt', context)).toBe('content');
    expect(decideLocalFilesPath(approval, '/Users/jo/Library/Mail/x.emlx', context)).toBe('denied');
    // A default-off folder inside the turned-on one stays off.
    expect(decideLocalFilesPath(approval, '/Users/jo/Library/Mobile Documents/p/node_modules/x.js', context)).toBe('denied');
    const gitOn = { selections: [sel('/Users/jo/Code/.git')], wholeAccount: false };
    expect(decideLocalFilesPath(gitOn, '/Users/jo/Code/.git/config', context)).toBe('content');
  });

  test('another disk with the same mount name has its own keys and starts unselected', () => {
    const approval = { selections: [sel('/@mac-aaaa-1111/Docs')], wholeAccount: false };
    expect(decideLocalFilesPath(approval, '/@mac-aaaa-1111/Docs/a.txt', context)).toBe('content');
    expect(decideLocalFilesPath(approval, '/@mac-bbbb-2222/Docs/a.txt', context)).toBe('denied');
  });
});

describe('local files connector and store sync', () => {
  test('lists the approved folder by lstat: files, symlinks by name only, nothing off by default', async () => {
    const f = fixture();
    writeFileSync(join(f.proj, 'quarterly-report.txt'), 'alpha');
    mkdirSync(join(f.proj, 'sub'));
    writeFileSync(join(f.proj, 'sub', 'budget-notes.md'), 'bravo');
    mkdirSync(join(f.proj, '.git'));
    writeFileSync(join(f.proj, '.git', 'config-secret-name'), 'x');
    mkdirSync(join(f.proj, 'node_modules'));
    writeFileSync(join(f.proj, 'node_modules', 'dep-index.js'), 'x');
    const outside = join(f.base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'outside-secret.txt'), 'SECRET');
    symlinkSync(outside, join(f.proj, 'escape-link'));
    symlinkSync(join(outside, 'outside-secret.txt'), join(f.proj, 'file-link.txt'));

    const out = await f.handler().pull({ approved_scope_key: f.approvedKey });
    expect(out.receipt.counts.traversal_complete).toBe(1);
    expect(out.receipt.counts.full_listing).toBe(1);

    expect(names(f.store, 'quarterly')).toEqual(['quarterly-report.txt']);
    expect(names(f.store, 'budget')).toEqual(['budget-notes.md']);
    expect(names(f.store, 'config')).toEqual([]);
    expect(names(f.store, 'dep')).toEqual([]);
    // The link is known by its name and nothing under or behind it is.
    expect(names(f.store, 'link')).toEqual(['escape-link', 'file-link.txt']);
    expect(names(f.store, 'outside')).toEqual([]);
    expect(out.checkpoint).toBeTruthy();
  });

  test('a new, edited, deleted file and a moved folder reach the index on the next pass', async () => {
    const f = fixture();
    mkdirSync(join(f.proj, 'taxes'));
    writeFileSync(join(f.proj, 'taxes', 'return-2024.txt'), 'one');
    writeFileSync(join(f.proj, 'taxes', 'receipts-2024.txt'), 'two');
    writeFileSync(join(f.proj, 'keep-me.txt'), 'three');
    writeFileSync(join(f.proj, 'doomed.txt'), 'four');
    const handler = f.handler();

    const first = await handler.pull({ approved_scope_key: f.approvedKey });
    expect(first.receipt.counts.full_listing).toBe(1);
    expect(names(f.store, 'return')).toEqual(['return-2024.txt']);
    expect(first.checkpoint).toBeTruthy();

    // New and deleted.
    writeFileSync(join(f.proj, 'fresh-invoice.txt'), 'five');
    rmSync(join(f.proj, 'doomed.txt'));
    // A folder moved: every file under the old name goes, the new name arrives.
    renameSync(join(f.proj, 'taxes'), join(f.proj, 'taxes-archive'));
    await settleFileEvents();
    const second = await handler.pull({ approved_scope_key: f.approvedKey, checkpoint: first.checkpoint! });
    expect(second.receipt.counts.full_listing).toBe(0);
    expect(names(f.store, 'txt')).toEqual(['fresh-invoice.txt', 'keep-me.txt', 'receipts-2024.txt', 'return-2024.txt']);
    const hits = f.store.searchItems('return', 10, 'this_computer');
    expect(hits).toHaveLength(1);
    expect(f.store.localContent(hits[0]!.sourceItem.localItemId)?.locatorUri).toBe(join(f.proj, 'taxes-archive', 'return-2024.txt'));
    
    // A deleted folder takes its whole subtree.
    rmSync(join(f.proj, 'taxes-archive'), { recursive: true });
    await settleFileEvents();
    const third = await handler.pull({ approved_scope_key: f.approvedKey, checkpoint: second.checkpoint! });
    expect(third.receipt.counts.items_tombstoned).toBeGreaterThanOrEqual(2);
    expect(names(f.store, 'txt')).toEqual(['fresh-invoice.txt', 'keep-me.txt']);
      });

  test('changes made while Olympus was stopped are found from the snapshot, with no rescan', async () => {
    const f = fixture();
    writeFileSync(join(f.proj, 'before-restart.txt'), 'one');
    writeFileSync(join(f.proj, 'gone-while-stopped.txt'), 'two');
    const first = await f.handler().pull({ approved_scope_key: f.approvedKey });
    await f.hub.close();

    writeFileSync(join(f.proj, 'written-while-stopped.txt'), 'three');
    rmSync(join(f.proj, 'gone-while-stopped.txt'));

    // A new process: a new hub, the same store and snapshot directory.
    const hub = new WatchHub();
    cleanups.push(() => hub.close());
    await settleFileEvents();
    const second = await f.handler(hub).pull({ approved_scope_key: f.approvedKey, checkpoint: first.checkpoint! });
    expect(second.receipt.counts.full_listing).toBe(0);
    expect(names(f.store, 'txt')).toEqual(['before-restart.txt', 'written-while-stopped.txt']);
  });

  test('a lost change history falls back to a full listing that removes what vanished', async () => {
    const f = fixture();
    writeFileSync(join(f.proj, 'stays.txt'), 'one');
    writeFileSync(join(f.proj, 'vanishes.txt'), 'two');
    const first = await f.handler().pull({ approved_scope_key: f.approvedKey });
    rmSync(join(f.proj, 'vanishes.txt'));
    rmSync(f.snapshotDir, { recursive: true, force: true });
    mkdirSync(f.snapshotDir, { recursive: true });

    const second = await f.handler().pull({ approved_scope_key: f.approvedKey, checkpoint: first.checkpoint! });
    expect(second.receipt.counts.history_reset).toBe(1);
    expect(second.receipt.counts.full_listing).toBe(1);
    expect(names(f.store, 'txt')).toEqual(['stays.txt']);
  });

  test('without a file watcher every pass lists the folder, says so, and still removes deletions', async () => {
    const f = fixture();
    const hub = new WatchHub({ load: async () => { throw new Error('no native module'); } });
    cleanups.push(() => hub.close());
    writeFileSync(join(f.proj, 'one.txt'), 'one');
    writeFileSync(join(f.proj, 'two.txt'), 'two');
    const handler = f.handler(hub);
    const first = await handler.pull({ approved_scope_key: f.approvedKey });
    expect(first.receipt.counts.live_updates_off).toBe(1);
    expect(first.receipt.warnings).toContain('local_files_live_updates_off');
    expect(hub.problemsNow().map((problem) => problem.kind)).toContain('watcher_unavailable');

    rmSync(join(f.proj, 'two.txt'));
    const second = await handler.pull({ approved_scope_key: f.approvedKey, checkpoint: first.checkpoint! });
    expect(second.receipt.counts.full_listing).toBe(1);
    expect(names(f.store, 'txt')).toEqual(['one.txt']);
  });

  test('a folder that cannot be read is skipped without removing what was indexed under it', async () => {
    if (process.getuid?.() === 0) return;
    const f = fixture();
    mkdirSync(join(f.proj, 'locked'));
    writeFileSync(join(f.proj, 'locked', 'inside-locked.txt'), 'one');
    writeFileSync(join(f.proj, 'open.txt'), 'two');
    const handler = f.handler(null);
    await handler.pull({ approved_scope_key: f.approvedKey });
    expect(names(f.store, 'txt')).toEqual(['inside-locked.txt', 'open.txt']);

    chmodSync(join(f.proj, 'locked'), 0o000);
    cleanups.push(() => { try { chmodSync(join(f.proj, 'locked'), 0o755); } catch { /* gone */ } });
    const second = await handler.pull({ approved_scope_key: f.approvedKey });
    expect(second.receipt.counts.unreadable_folders).toBe(1);
    expect(second.receipt.counts.traversal_complete).toBe(1);
    expect(second.receipt.warnings).toContain('local_files_unreadable_folders');
    expect(names(f.store, 'txt')).toEqual(['inside-locked.txt', 'open.txt']);
  });

  test('fetch reads only inside the approved folder and only the file that was listed', async () => {
    const f = fixture();
    writeFileSync(join(f.proj, 'design-doc.txt'), 'alpha-content');
    const outside = join(f.base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'x.txt'), 'SECRET');
    const handler = f.handler();
    await handler.pull({ approved_scope_key: f.approvedKey });
    const row = f.store.searchItems('design', 10, 'this_computer')[0]!;
    const localItemId = row.sourceItem.localItemId;
    const version = row.sourceItem.sourceVersion;
    const locator = join(f.proj, 'design-doc.txt');
    const connector = createLocalFilesSourceConnector({
      connectorId: 'test',
      root: f.proj,
      scope: f.scope,
      volumes: new VolumeResolver(),
      locate: (id) => (id === localItemId ? locator : undefined),
    });

    const read = await connector.fetchItemWithin(localItemId, { ...(version ? { expectedVersion: version } : {}) });
    expect(read.content.kind).toBe('bytes');
    expect(read.content.kind === 'bytes' ? Buffer.from(read.content.bytes).toString() : '').toBe('alpha-content');

    // Replaced by a different file at the same name: changed, not read.
    writeFileSync(join(f.proj, 'design-doc.new'), 'swapped');
    renameSync(join(f.proj, 'design-doc.new'), locator);
    await expect(connector.fetchItemWithin(localItemId, { ...(version ? { expectedVersion: version } : {}) })).rejects.toThrow();

    // Swapped for a link to outside: refused, never read.
    rmSync(locator);
    symlinkSync(join(outside, 'x.txt'), locator);
    await expect(connector.fetchItemWithin(localItemId, {})).rejects.toThrow();

    // Too large for the caller's ceiling.
    rmSync(locator);
    writeFileSync(locator, 'x'.repeat(100));
    const big = await connector.fetchItemWithin(localItemId, { maxBytes: 10 });
    expect(big.content.kind).toBe('metadata_only');
    expect(big.metadata['contentTooLarge']).toBe(true);

    // A path the person's scope does not allow is not read at all.
    f.selections.splice(0, f.selections.length, { key: join(f.proj, 'elsewhere'), state: 'ingest' });
    const denied = await connector.fetchItemWithin(localItemId, {});
    expect(denied.metadata['scopeContentDenied']).toBe(true);
  });

  test('an iCloud placeholder is listed by name and never read', async () => {
    const f = fixture();
    writeFileSync(join(f.proj, 'in-the-cloud.txt'), 'real bytes');
    const real = scopeSafeNativeForTests();
    if (!real) return;
    // Report every regular file as a placeholder, as the Mac does for an iCloud-only file.
    resetScopeSafeNativeForTests({ ...real, fstatFlags: () => 0x40000000 });
    const connector = createLocalFilesSourceConnector({
      connectorId: 'placeholder',
      root: f.proj,
      scope: f.scope,
      volumes: new VolumeResolver(),
      locate: () => join(f.proj, 'in-the-cloud.txt'),
    });
    const items = [];
    for await (const page of connector.listItems()) items.push(...page.items);
    const item = items.find((entry) => entry.metadata['name'] === 'in-the-cloud.txt');
    expect(item?.metadata['placeholder']).toBe(true);
    expect(item?.metadata['contentScope']).toBe('names_only');
    expect(item?.identity.sourceVersion?.endsWith('.p')).toBe(true);
    const fetched = await connector.fetchItemWithin(item!.identity.localItemId, {});
    expect(fetched.content.kind).toBe('metadata_only');
  });

  test('item identity is the path, so a rename is one deletion and one new item', () => {
    expect(localFilesItemId('/a/b.txt')).toBe(localFilesItemId('/a/b.txt'));
    expect(localFilesItemId('/a/b.txt')).not.toBe(localFilesItemId('/a/c.txt'));
    expect(LOCAL_FILES_POLL_CURSOR).toBe('lf1:poll');
    expect(existsSync('/')).toBe(true);
  });
});
