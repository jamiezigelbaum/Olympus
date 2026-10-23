// Follow-ups for the local files source: case handling decided per volume,
// nested chosen folders keeping their own live watch, files directly under `/`
// being noticed when they are gone, and the packaged watcher loading.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { defaultLocalFilesIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import {
  LOCAL_FILES_CURSOR_PREFIX, createLocalFilesSourceConnector, type LocalFilesStoreView,
} from '../src/workers/local-files/connector.ts';
import {
  foldScopePath,
  scopePathIsWithin,
  scopePathsIgnoreCase,
  type DefaultExclusionContext,
} from '../src/workers/local-files/paths.ts';
import { watchApprovedFolders } from '../src/workers/local-files/scheduler-source.ts';
import {
  decideLocalFilesPath,
  localFilesRoots,
  LOCAL_FILES_POLICY_SOURCE,
  type LocalFilesContentScope,
} from '../src/workers/local-files/scope.ts';
import { createLocalFilesConnectorStore, LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV } from '../src/workers/local-files/store.ts';
import { VolumeResolver, probeIgnoresCaseIn } from '../src/workers/local-files/volume-identity.ts';
import {
  WatchHub, watchIgnoreGlobs, watchWouldIgnore, type ParcelWatcherModule, type WatchEvent,
} from '../src/workers/local-files/watch-hub.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function scratch(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lf-followups-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

const VOLUME = 'mac-aaaaaaaa-1111-2222-3333-444444444444';

// ---------------------------------------------------------------------------
// 5. Case is decided per volume
// ---------------------------------------------------------------------------

describe('one decision for case, made per volume', () => {
  const ctx = (platform: NodeJS.Platform, byVolume: Record<string, boolean | undefined> = {}): DefaultExclusionContext => ({
    home: '/Users/jo', syncedRoots: [], platform,
    volumeIgnoresCase: (volumeId) => byVolume[volumeId ?? 'primary'],
  });

  test('the volume decides when it is known, the platform when it is not', () => {
    // A Mac whose own volume was formatted case-sensitive; a stick that ignores case on Linux.
    expect(scopePathsIgnoreCase(ctx('darwin', { primary: false }), '/Users/jo/a')).toBe(false);
    expect(scopePathsIgnoreCase(ctx('linux', { [VOLUME]: true }), `/@${VOLUME}/Docs`)).toBe(true);
    expect(scopePathsIgnoreCase(ctx('linux', { [VOLUME]: true }), '/home/jo/Docs')).toBe(false);
    // Unknown: the platform's usual format.
    expect(scopePathsIgnoreCase(ctx('darwin'), '/Users/jo/a')).toBe(true);
    expect(scopePathsIgnoreCase(ctx('linux'), '/home/jo/a')).toBe(false);
    expect(scopePathsIgnoreCase({ platform: 'darwin' }, '/Users/jo/a')).toBe(true);
    expect(foldScopePath('/Users/Jo', ctx('darwin', { primary: false }))).toBe('/Users/Jo');
    expect(foldScopePath('/Users/Jo', ctx('darwin', { primary: true }))).toBe('/users/jo');
    expect(scopePathIsWithin('/Users/jo/DOCS/x', '/users/jo/docs', ctx('darwin'))).toBe(true);
    expect(scopePathIsWithin('/Users/jo/DOCS/x', '/users/jo/docs', ctx('darwin', { primary: false }))).toBe(false);
  });

  test('a saved exclusion follows the volume: `private` is `Private` only where case is ignored', () => {
    const selections = [{ key: '/Users/jo/proj', state: 'ingest' as const }, { key: '/Users/jo/proj/Private', state: 'exclude' as const }];
    const decide = (context: DefaultExclusionContext) => decideLocalFilesPath({ selections, wholeAccount: false }, '/Users/jo/proj/private/a.txt', context);
    expect(decide(ctx('darwin', { primary: true }))).toBe('denied');
    expect(decide(ctx('darwin', { primary: false }))).toBe('content');
    expect(decide(ctx('linux', { primary: true }))).toBe('denied');
    expect(decide(ctx('linux'))).toBe('content');
  });

  test('a volume reads its own format: one real name with its case swapped', () => {
    const base = scratch();
    const dir = join(base, 'v');
    mkdirSync(dir);
    writeFileSync(join(dir, 'Probe.txt'), 'x');
    // Whatever this machine's disk does, the probe agrees with what it just did.
    const ignores = existsSync(join(dir, 'pROBE.TXT'));
    expect(probeIgnoresCaseIn(dir)).toBe(ignores);
    expect(probeIgnoresCaseIn(join(base, 'missing'))).toBeUndefined();
    mkdirSync(join(base, 'digits'));
    writeFileSync(join(base, 'digits', '123'), 'x');
    expect(probeIgnoresCaseIn(join(base, 'digits'))).toBeUndefined();
  });

  test('VolumeResolver answers per volume, remembers it, and says nothing for a disk that is not mounted', () => {
    const probed: string[] = [];
    const volumes = new VolumeResolver({
      platform: 'darwin',
      home: '/Users/jo',
      readMounts: () => '/dev/disk3s1s1 on / (apfs, local)\n/dev/disk5s1 on /Volumes/Backup (apfs, local)',
      diskutilPlist: () => `<key>VolumeUUID</key><string>${VOLUME.slice(4).toUpperCase()}</string>`,
      probeIgnoresCase: (dir) => {
        probed.push(dir);
        return dir === '/Volumes/Backup' ? false : dir === '/Users/jo' ? true : undefined;
      },
    });
    expect(volumes.ignoresCase(undefined)).toBe(true);
    expect(volumes.ignoresCase(VOLUME)).toBe(false);
    expect(volumes.ignoresCase(VOLUME)).toBe(false);
    expect(probed).toEqual(['/Users/jo', '/Volumes/Backup']);
    expect(volumes.ignoresCase('mac-ffffffff-0000-0000-0000-000000000000')).toBeUndefined();
    // Nothing to read in the home folder: the volume's top is tried next.
    const bare = new VolumeResolver({
      platform: 'darwin', home: '/Users/jo', readMounts: () => '/dev/disk3s1s1 on / (apfs, local)',
      probeIgnoresCase: (dir) => (dir === '/' ? false : undefined),
    });
    expect(bare.ignoresCase(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connector harness (fake watcher, real folder)
// ---------------------------------------------------------------------------

function connectorFixture(options: { ignoresCase?: boolean; root?: string; decide?: LocalFilesContentScope['decide'] } = {}) {
  const base = scratch();
  const home = join(base, 'home');
  const chosen = join(home, 'proj');
  mkdirSync(chosen, { recursive: true });
  const selections = [{ key: chosen, state: 'ingest' as const }];
  const context: DefaultExclusionContext = { home, syncedRoots: [], platform: 'darwin' };
  const scope: LocalFilesContentScope = {
    generation: 'a'.repeat(64),
    revision: '11111111-2222-4333-8444-555555555555',
    assertCurrent() {},
    ...(options.ignoresCase === undefined ? {} : { ignoresCase: () => options.ignoresCase! }),
    decide: options.decide ?? ((path) => decideLocalFilesPath({ selections, wholeAccount: false }, path, context)),
    snapshotDecider: () => options.decide ?? ((path) => decideLocalFilesPath({ selections, wholeAccount: false }, path, context)),
    roots: () => localFilesRoots({ selections, wholeAccount: false }),
  };
  mkdirSync(join(base, 'watch'), { recursive: true });
  const hub = (events: (dir: string) => WatchEvent[]): WatchHub => {
    const created = new WatchHub({
      load: async (): Promise<ParcelWatcherModule> => ({
        subscribe: async () => ({ unsubscribe: async () => undefined }),
        writeSnapshot: async (_dir, snapshotPath) => { writeFileSync(snapshotPath, 'snap'); return snapshotPath; },
        getEventsSince: async (dir) => events(dir),
      }),
    });
    cleanups.push(() => created.close());
    return created;
  };
  return { base, home, chosen, scope, selections, hub, volumes: new VolumeResolver() };
}

async function listAll(connector: ReturnType<typeof createLocalFilesSourceConnector>, cursor?: string) {
  const items = [];
  for await (const page of connector.listItems(cursor ? { cursor } : undefined)) items.push(...page.items);
  return items;
}

describe('watcher replay follows the volume\'s case rule', () => {
  async function replay(ignoresCase: boolean) {
    const f = connectorFixture({ ignoresCase });
    writeFileSync(join(f.chosen, 'fresh.txt'), 'new');
    // The watcher reports the folder under a different spelling than the real path.
    const spelled = join(f.chosen.replace('/proj', '/PROJ'), 'fresh.txt');
    const hub = f.hub(() => [{ type: 'create', path: spelled }]);
    writeFileSync(join(f.base, 'watch', 'cs.prior.snap'), 'snap');
    const connector = createLocalFilesSourceConnector({
      connectorId: 'cs', root: f.chosen, scope: f.scope, volumes: f.volumes,
      watch: { hub, snapshotDir: join(f.base, 'watch') },
    });
    return listAll(connector, `${LOCAL_FILES_CURSOR_PREFIX}prior`);
  }

  test('on a volume that ignores case, an event spelled differently is the same folder', async () => {
    const items = await replay(true);
    expect(items.map((item) => item.metadata['name'])).toEqual(['fresh.txt']);
  });

  test('on a volume that does not, it is another path and is not replayed in', async () => {
    expect(await replay(false)).toEqual([]);
  });
});

describe('what is gone is judged by the same rule', () => {
  async function walkWithStoredItem(ignoresCase: boolean) {
    if (process.getuid?.() === 0) return undefined;
    const f = connectorFixture({ ignoresCase });
    const locked = join(f.chosen, 'Locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'x.txt'), 'x');
    chmodSync(locked, 0o000);
    cleanups.push(() => chmodSync(locked, 0o755));
    // Indexed before the folder was renamed to another case: the stored spelling differs.
    const stored = join(f.chosen, 'locked', 'x.txt');
    const store: LocalFilesStoreView = {
      activeIdentityForLocatorIfIndexed: () => undefined,
      activeItemsUnderLocatorIfIndexed: () => [{
        identity: { family: 'file', provider: 'local_files', accountScope: 'this_computer', providerItemId: 'p1', localItemId: 'this_computer:p1' },
        locatorUri: stored,
      }],
    };
    const connector = createLocalFilesSourceConnector({ connectorId: 'gone', root: f.chosen, scope: f.scope, volumes: f.volumes, store });
    return (await listAll(connector)).filter((item) => item.metadata['deleted'] === true).map((item) => item.metadata['locatorUri']);
  }

  test('an item under a folder the walk could not read is not judged, even when the folder\'s case changed (case ignored)', async () => {
    expect(await walkWithStoredItem(true)).toEqual([]);
  });

  test('where case matters it is another path, so it is judged absent', async () => {
    const gone = await walkWithStoredItem(false);
    if (gone !== undefined) expect(gone.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Nested chosen folders keep their own watch when the outer one cannot see them
// ---------------------------------------------------------------------------

describe('nested chosen folders and the live watch', () => {
  const HOME = '/Users/jo';
  const ICLOUD = `${HOME}/Library/Mobile Documents/com~apple~CloudDocs`;
  const context: DefaultExclusionContext = { home: HOME, syncedRoots: [], platform: 'darwin' };
  const ignore = watchIgnoreGlobs(context);
  const volumes = new VolumeResolver({
    platform: 'darwin',
    home: HOME,
    readMounts: () => '/dev/disk3s1s1 on / (apfs, local)\n/dev/disk5s1 on /Volumes/Backup (apfs, local)',
    diskutilPlist: () => `<key>VolumeUUID</key><string>${VOLUME.slice(4).toUpperCase()}</string>`,
  });
  const watched = (paths: string[]): string[] => {
    let roots: Array<{ root: string }> = [];
    watchApprovedFolders({ hub: { setRoots: (next: Array<{ root: string }>) => { roots = next; } } as never, volumes, ignore }, paths);
    return roots.map((entry) => entry.root).sort();
  };

  test('a plain nested folder is covered by the outer one', () => {
    expect(watched([HOME, `${HOME}/Code/app`])).toEqual([HOME]);
    expect(watched(['/', HOME])).toEqual(['/']);
  });

  test('iCloud Drive inside the home folder keeps its own watch (the home watch leaves Library out)', () => {
    expect(watched([HOME, ICLOUD])).toEqual([HOME, ICLOUD].sort());
    expect(watched(['/', ICLOUD])).toEqual(['/', ICLOUD].sort());
    expect(watchWouldIgnore(ignore, HOME, ICLOUD)).toBe(true);
    expect(watchWouldIgnore(ignore, HOME, `${HOME}/Code/app`)).toBe(false);
  });

  test('a folder on another disk under the whole computer keeps its own watch', () => {
    const backup = `/@${VOLUME}/Photos`;
    expect(watched(['/', backup]).sort()).toEqual(['/', '/Volumes/Backup/Photos']);
  });

  test('a chosen folder inside a skipped one keeps its own watch', () => {
    expect(watched([HOME, `${HOME}/Code/app/node_modules/pkg`])).toEqual([HOME, `${HOME}/Code/app/node_modules/pkg`].sort());
  });

  test('a folder whose disk is not mounted is left out until it returns', () => {
    expect(watched([HOME, `/@mac-00000000-0000-0000-0000-000000000000/x`])).toEqual([HOME]);
  });
});

// ---------------------------------------------------------------------------
// 8. Files directly under `/`
// ---------------------------------------------------------------------------

describe('files directly under the whole computer\'s top', () => {
  const identity = (id: string) => ({ family: 'file' as const, provider: 'local_files', accountScope: 'this_computer', providerItemId: id, localItemId: `this_computer:${id}` });

  test('a full walk of `/` tombstones an indexed top-level file that is gone; a folder root asks nothing of the kind', async () => {
    const asked: string[] = [];
    const store: LocalFilesStoreView = {
      activeIdentityForLocatorIfIndexed: () => undefined,
      activeItemsUnderLocatorIfIndexed: ({ locatorUri }) => { asked.push(`under:${locatorUri}`); return []; },
      activeItemsDirectlyUnderRootIfIndexed: () => {
        asked.push('top-level');
        return [{ identity: identity('top'), locatorUri: '/olympus-test-no-such-file.txt' }];
      },
    };
    // Nothing is chosen, so the walk lists `/` and descends nowhere.
    const f = connectorFixture({ decide: () => 'denied' });
    const whole = createLocalFilesSourceConnector({ connectorId: 'top', root: '/', scope: { ...f.scope, roots: () => [] }, volumes: f.volumes, store });
    const deleted = (await listAll(whole)).filter((item) => item.metadata['deleted'] === true);
    expect(deleted.map((item) => item.metadata['locatorUri'])).toEqual(['/olympus-test-no-such-file.txt']);
    expect(asked).toContain('top-level');

    asked.length = 0;
    const folder = createLocalFilesSourceConnector({ connectorId: 'proj', root: f.chosen, scope: f.scope, volumes: f.volumes, store });
    expect(await listAll(folder)).toEqual([]);
    expect(asked).not.toContain('top-level');
  });

  test('the store lists exactly the items directly under `/`, active ones only', async () => {
    const base = scratch();
    const store = createLocalFilesConnectorStore({
      [LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV]: join(base, 'store.sqlite'),
      [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(base, 'none.json'),
    }, { policy: defaultLocalFilesIngestionPolicy({ stillImagesRead: false }) });
    cleanups.push(() => store.close());
    const root = join(base, 'proj');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'alpha');
    writeFileSync(join(root, 'sub', 'b.txt'), 'bravo');
    const { createLocalFilesProviderStoreSyncHandler } = await import('../src/workers/local-files/provider-store-sync.ts');
    const scope: LocalFilesContentScope = {
      generation: 'a'.repeat(64), revision: '11111111-2222-4333-8444-555555555555', assertCurrent() {},
      decide: () => 'content', snapshotDecider: () => () => 'content', roots: () => [{ scopePath: root, state: 'ingest' }],
    };
    const handler = createLocalFilesProviderStoreSyncHandler({ store, scope, volumes: new VolumeResolver(), snapshotDir: join(base, 'watch') });
    await handler.pull({ approved_scope_key: `${LOCAL_FILES_POLICY_SOURCE}:${root}` });
    const query = { provider: 'local_files', accountScope: 'this_computer', limit: 100 };
    expect(store.activeItemsDirectlyUnderRootIfIndexed(query)).toEqual([]);
    // Move two indexed items to where a top-level file would be indexed, one of them tombstoned.
    const db = (store as unknown as { db: Database }).db;
    const rows = db.query("SELECT item_pk FROM items WHERE locator_uri LIKE '%.txt' ORDER BY item_pk").all() as Array<{ item_pk: number }>;
    expect(rows.length).toBe(2);
    db.exec(`UPDATE items SET locator_uri = '/Top-Level.txt' WHERE item_pk = ${rows[0]!.item_pk}`);
    const direct = store.activeItemsDirectlyUnderRootIfIndexed(query);
    expect(direct.map((entry) => entry.locatorUri)).toEqual(['/Top-Level.txt']);
    expect(store.activeItemsDirectlyUnderRootIfIndexed({ ...query, limit: 0 })).toEqual([]);
    db.exec(`UPDATE items SET tombstoned = 1 WHERE item_pk = ${rows[0]!.item_pk}`);
    expect(store.activeItemsDirectlyUnderRootIfIndexed(query)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. The packaged watcher
// ---------------------------------------------------------------------------

describe('the packaged build can load and use the native watcher', () => {
  const dist = (name: string) => readFileSync(resolve('dist', name), 'utf8');

  test('the built engine (dist/cli.js, which runs the worker) loads the watcher by name at run time and does not carry the native addon inside itself', () => {
    const text = dist('cli.js');
    // Booleans, so a failure does not print the whole bundle.
    expect(text.includes('const specifier = "@parcel/watcher"')).toBe(true);
    expect(text.includes('await import(specifier)')).toBe(true);
    expect(text.includes('OLYMPUS_NATIVE_MODULES_DIR')).toBe(true);
    expect(/\.node["')]/.test(text)).toBe(false);
  });

  test('a bundle made the way dist is made finds the watcher in the packaged native-modules folder and gets a real change event', () => {
    const base = scratch();
    // The packaged layout: no node_modules above the bundle, the addon in a folder named by the environment.
    const native = join(base, 'native');
    mkdirSync(join(native, 'node_modules', '@parcel'), { recursive: true });
    symlinkSync(realpathSync(resolve('node_modules', '@parcel', 'watcher')), join(native, 'node_modules', '@parcel', 'watcher'));
    writeFileSync(join(native, 'package.json'), '{}');
    const entry = join(base, 'entry.ts');
    writeFileSync(entry, `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { WatchHub } from ${JSON.stringify(resolve('src/workers/local-files/watch-hub.ts'))};
      const dir = process.argv[2]!;
      const hub = new WatchHub();
      let woke = false;
      hub.subscribeChanges(() => { woke = true; });
      hub.setRoots([{ root: dir }]);
      await new Promise((done) => setTimeout(done, 1500));
      writeFileSync(join(dir, 'new.txt'), 'hello');
      for (let i = 0; i < 100 && !woke; i += 1) await new Promise((done) => setTimeout(done, 100));
      console.log(JSON.stringify({ woke, problems: hub.problemsNow() }));
      await hub.close();
      process.exit(0);
    `);
    const out = join(base, 'out');
    const built = spawnSync(process.execPath, ['build', entry, '--target=node', '--format=esm', `--outfile=${join(out, 'watch.mjs')}`], { encoding: 'utf8' });
    expect(built.status).toBe(0);
    const watched = join(base, 'watched');
    mkdirSync(watched);
    const ran = spawnSync(process.execPath, [join(out, 'watch.mjs'), watched], {
      cwd: out, encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH ?? '', HOME: base, OLYMPUS_NATIVE_MODULES_DIR: native },
    });
    expect(ran.status).toBe(0);
    expect(JSON.parse(ran.stdout.trim().split('\n').pop()!)).toEqual({ woke: true, problems: [] });
  }, 60_000);
});
