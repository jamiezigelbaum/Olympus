// Files on this computer never index what Olympus itself writes, wherever an
// environment variable or the plugin config moves a writer, and even what an
// earlier version indexed in a folder the person had chosen by name. These
// tests pin the rule as reviews shaped it:
//  1. a capture folder moved by an environment variable or the plugin config is
//     Olympus's whole, when it is a dedicated folder;
//  2. the Mac's app and log folders are Olympus's;
//  3. a move to the home folder, a shared base or a folder above one protects
//     nothing and excludes nothing of the person's;
//  4. a link does not carry a move past that rule: where it leads is judged;
//  5. what an earlier version indexed inside an own folder is removed at start,
//     judged path by path with the case rules of its volume.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configuredCaptureLocations } from '../src/core/config.ts';
import type { SourceConnector } from '../src/core/contracts.ts';
import { isDedicatedOlympusFolder, olympusOwnLocations, olympusOwnRoots } from '../src/core/olympus-layout.ts';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { defaultLocalFilesIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { localFilesItemId } from '../src/workers/local-files/connector.ts';
import { LOCAL_FILES_OWN_ROOTS_CLEANUP_CONNECTOR_ID, createLocalFilesOwnRootsCleanup, createLocalFilesOwnRootsRecovery } from '../src/workers/local-files/own-roots-cleanup.ts';
import {
  defaultExclusionContext,
  defaultExclusionForFolder,
  type DefaultExclusionContext,
} from '../src/workers/local-files/paths.ts';
import { createLocalFilesProviderStoreSyncHandler } from '../src/workers/local-files/provider-store-sync.ts';
import { createLocalFilesFolderScopeBrowser } from '../src/workers/local-files/scope-browser.ts';
import {
  LOCAL_FILES_ACCOUNT_SCOPE,
  LOCAL_FILES_POLICY_SOURCE,
  LOCAL_FILES_PROVIDER,
  LOCAL_FILES_SOURCE_ID,
  decideLocalFilesPath,
  localFilesRoots,
  type LocalFilesContentScope,
} from '../src/workers/local-files/scope.ts';
import {
  LOCAL_FILES_CORPUS_ID,
  createLocalFilesConnectorStore,
  createLocalFilesTierLane,
  LOCAL_FILES_STORE_PLACEMENT,
} from '../src/workers/local-files/store.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { WatchHub, watchIgnoreGlobs } from '../src/workers/local-files/watch-hub.ts';
import { fileSourceScopeContentFilters, fileSourceScopeMetadataFilters } from '../src/workers/source-scope-runtime.ts';
import { localFilesTestTierSet } from './helpers/lane-tier-sets.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

type Env = Record<string, string | undefined>;
type Approval = { selections: Array<{ key: string; state: 'ingest' | 'metadata_only' | 'exclude' }>; wholeAccount: boolean };

function tempBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'own-roots-overrides-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

const choose = (...keys: string[]): Approval => ({ selections: keys.map((key) => ({ key, state: 'ingest' as const })), wholeAccount: false });
const everything: Approval = { selections: [], wholeAccount: true };
/** A day's file in a Telegram or WhatsApp spool, named as the writers name it. */
const day = '2026-10-24.jsonl';

/** The context a worker builds for `env`, with the folders it reads off the file system left alone. */
function contextFor(env: Env, capture: Parameters<typeof defaultExclusionContext>[1] = {}, platform: NodeJS.Platform = 'linux'): DefaultExclusionContext {
  return { ...defaultExclusionContext(env, capture), syncedRoots: [], platform };
}

describe('1. a capture folder moved by an environment variable or the plugin config', () => {
  for (const name of ['OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR', 'OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR']) {
    test(`${name}=~/capture: with home chosen, its messages are neither read nor watched`, () => {
      const home = join(tempBase(), 'home');
      const context = contextFor({ HOME: home, [name]: join(home, 'capture') });
      expect(context.ownRoots).toContain(join(home, 'capture'));
      expect(defaultExclusionForFolder(join(home, 'capture'), context)).toBe('olympus_data');
      expect(decideLocalFilesPath(choose(home), join(home, 'capture', day), context)).toBe('denied');
      expect(decideLocalFilesPath(everything, join(home, 'capture', day), context)).toBe('denied');
      expect(decideLocalFilesPath(choose(home), join(home, 'Documents', 'budget.txt'), context)).toBe('content');
      expect(watchIgnoreGlobs(context)).toContain(join(home, 'capture'));
    });
  }

  test('the other writers\' folders move the same way', () => {
    const home = join(tempBase(), 'home');
    for (const name of ['OLYMPUS_WHATSAPP_STATE_DIR', 'OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR', 'OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR']) {
      const folder = join(home, `moved-${name.toLowerCase()}`);
      const context = contextFor({ HOME: home, [name]: folder });
      expect(context.ownRoots, name).toContain(folder);
      expect(decideLocalFilesPath(choose(home), join(folder, 'anything.txt'), context), name).toBe('denied');
    }
    // The WhatsApp location may name the session database inside the folder.
    const folder = join(home, 'wa');
    expect(contextFor({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: join(folder, 'session.db') }).ownRoots).toContain(folder);
  });

  test('the plugin config moves the spool and the gateway state the same way', () => {
    const home = join(tempBase(), 'home');
    const context = contextFor({ HOME: home }, {
      telegramSpoolDir: join(home, 'cfg-spool'),
      telegramStateDir: join(home, 'cfg-gateway'),
      whatsappStateDir: join(home, 'cfg-whatsapp'),
    });
    for (const folder of ['cfg-spool', 'cfg-gateway', 'cfg-whatsapp']) {
      expect(context.ownRoots, folder).toContain(join(home, folder));
      expect(decideLocalFilesPath(choose(home), join(home, folder, 'anything.txt'), context), folder).toBe('denied');
    }
  });

  test('the worker reads those settings from the engine config it was started with', () => {
    const home = join(tempBase(), 'home');
    mkdirSync(join(home, '.olympus'), { recursive: true });
    writeFileSync(join(home, '.olympus', 'engine.json'), JSON.stringify({
      worker: {
        telegramCapture: { enabled: false, stateDir: join(home, 'engine-gateway'), spoolDir: join(home, 'engine-spool') },
        whatsappCapture: { enabled: false, stateDir: join(home, 'engine-whatsapp') },
      },
    }));
    const env = { HOME: home, OLYMPUS_ENGINE_HOST: '1' };
    expect(configuredCaptureLocations(env)).toEqual({
      telegramStateDir: join(home, 'engine-gateway'),
      telegramSpoolDir: join(home, 'engine-spool'),
      whatsappStateDir: join(home, 'engine-whatsapp'),
    });
    const context = { ...defaultExclusionContext(env), syncedRoots: [] };
    for (const folder of ['engine-gateway', 'engine-spool', 'engine-whatsapp']) expect(context.ownRoots, folder).toContain(join(home, folder));
    // No config, or one that cannot be read, adds nothing and is no error.
    expect(configuredCaptureLocations({ HOME: join(home, 'nowhere') })).toEqual({});
    writeFileSync(join(home, '.olympus', 'engine.json'), '{ not json');
    expect(configuredCaptureLocations(env)).toEqual({});
  });
});

describe('2. the Mac\'s app and log folders', () => {
  const home = '/Users/jo';
  const darwin = (): DefaultExclusionContext => ({ ...contextFor({ HOME: home }, {}, 'darwin'), home });

  test('are Olympus\'s own, and a choice of either by name does not turn them on', () => {
    const context = darwin();
    for (const folder of [`${home}/Library/Logs/Olympus`, `${home}/Library/Application Support/Olympus`]) {
      expect(context.ownRoots, folder).toContain(folder);
      expect(defaultExclusionForFolder(folder, context), folder).toBe('olympus_data');
      expect(decideLocalFilesPath(choose(folder), `${folder}/engine.log`, context), folder).toBe('denied');
      expect(decideLocalFilesPath(choose(folder), `${folder}/app/index.js`, context), folder).toBe('denied');
      expect(decideLocalFilesPath(choose(home, folder), `${folder}/runtime/bun`, context), folder).toBe('denied');
      expect(localFilesRoots(choose(folder, `${home}/Documents`), context).map((root) => root.scopePath)).toEqual([`${home}/Documents`]);
      expect(watchIgnoreGlobs(context)).toContain(folder);
    }
  });

  test('everything else in Library still works as before when chosen by name', () => {
    const context = darwin();
    for (const folder of [
      `${home}/Library/Mobile Documents`,
      `${home}/Library/Application Support/Other`,
      `${home}/Library/Application Support/Olympus Notes`,
      `${home}/Library/Logs/Other`,
    ]) {
      expect(decideLocalFilesPath(choose(folder), `${folder}/a.txt`, context), folder).toBe('content');
    }
    // Library as a whole stays off by default; a choice above it does not turn it on.
    expect(defaultExclusionForFolder(`${home}/Library`, context)).toBe('system_library');
    expect(decideLocalFilesPath(choose(home), `${home}/Library/Application Support/Other/a.txt`, context)).toBe('denied');
  });

  test('the folder picker refuses them and says why', async () => {
    const base = tempBase();
    const real = join(base, 'home');
    mkdirSync(join(real, 'Library', 'Logs', 'Olympus'), { recursive: true });
    mkdirSync(join(real, 'Library', 'Application Support', 'Olympus'), { recursive: true });
    mkdirSync(join(real, 'Library', 'Application Support', 'Other'), { recursive: true });
    const volumes = new VolumeResolver({
      platform: 'darwin',
      home: real,
      readMounts: () => '/dev/disk3s1s1 on / (apfs, local)',
      diskutilPlist: () => '<key>VolumeUUID</key><string>AAAAAAAA-1111-2222-3333-444444444444</string>',
    });
    const context: DefaultExclusionContext = { ...contextFor({ HOME: real }, {}, 'darwin'), home: real };
    const browser = createLocalFilesFolderScopeBrowser({ volumes, context, home: real });
    const reason = /Olympus's own data is never indexed/;
    await expect(browser.validateSelections([{ key: join(real, 'Library', 'Logs', 'Olympus'), state: 'ingest' }])).rejects.toThrow(reason);
    await expect(browser.validateSelections([{ key: join(real, 'Library', 'Application Support', 'Olympus'), state: 'ingest' }])).rejects.toThrow(reason);
    await expect(browser.validateSelections([{ key: join(real, 'Library', 'Application Support', 'Other'), state: 'ingest' }])).resolves.toHaveLength(1);
  });
});

describe('3. a move to a folder that is not dedicated', () => {
  const home = '/home/jo';
  const writers = ['OLYMPUS_WHATSAPP_STATE_DIR', 'OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR', 'OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR', 'OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR', 'OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR'];
  test('OLYMPUS_WHATSAPP_STATE_DIR=~/.local/share: nothing is protected and the files beside it stay the person\'s', () => {
    const env = { HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: `${home}/.local/share` };
    const context = contextFor(env);
    expect(context.ownRoots).toEqual(contextFor({ HOME: home }).ownRoots);
    expect(decideLocalFilesPath(choose(home), `${home}/.local/share/other/notes.txt`, context)).toBe('content');
    expect(decideLocalFilesPath(choose(home), `${home}/.local/share/notes.txt`, context)).toBe('content');
    expect(watchIgnoreGlobs(context)).toEqual(watchIgnoreGlobs(contextFor({ HOME: home })));
  });

  test('none of the shared bases, nor a folder above one, is taken for any writer', () => {
    // Folders that exist, so that where each one really leads can be read off the disk.
    const base = tempBase();
    const real = join(base, 'home');
    const shared = {
      XDG_DATA_HOME: join(base, 'xdg-data'), XDG_CONFIG_HOME: join(base, 'xdg-config'), XDG_STATE_HOME: join(base, 'xdg-state'),
      XDG_CACHE_HOME: join(base, 'xdg-cache'), XDG_RUNTIME_DIR: join(base, 'run'),
    };
    const bases = [
      join(real, '.local', 'share'), join(real, '.config'), join(real, '.local', 'state'), join(real, '.cache'),
      join(real, 'Library'), join(real, 'Library', 'Application Support'), join(real, 'Library', 'Logs'),
      // An ancestor of one of those, and of the home folder itself.
      join(real, '.local'), base, dirname(base), '/',
      // The XDG values, wherever the environment puts them.
      shared.XDG_DATA_HOME, shared.XDG_CONFIG_HOME, shared.XDG_STATE_HOME, shared.XDG_CACHE_HOME, shared.XDG_RUNTIME_DIR,
    ];
    for (const folder of bases.slice(0, -1)) mkdirSync(folder, { recursive: true });
    const none = contextFor({ HOME: real, ...shared }).ownRoots;
    for (const folder of bases) {
      expect(isDedicatedOlympusFolder(folder, { HOME: real, ...shared }), folder).toBe(false);
      for (const name of writers) {
        const context = contextFor({ HOME: real, ...shared, [name]: folder });
        expect(context.ownRoots, `${name}=${folder}`).toEqual(none);
        expect(context.ownRoots, `${name}=${folder}`).not.toContain(folder);
      }
    }
  });

  test('a move to the home folder, or a folder above it, protects nothing and excludes nothing', () => {
    const base = tempBase();
    const real = join(base, 'home');
    for (const target of [real, base]) {
      for (const name of writers) {
        const context = contextFor({ HOME: real, [name]: target });
        expect(context.ownRoots, `${name}=${target}`).toEqual(contextFor({ HOME: real }).ownRoots);
        for (const approval of [choose(real), everything]) {
          // The person's own files, wherever the writer was told to go.
          for (const path of [join(real, 'Documents', 'budget.txt'), join(real, 'notes.db'), join(real, 'spool.txt')]) {
            expect(decideLocalFilesPath(approval, path, context), `${name}=${target} ${path}`).toBe('content');
          }
        }
      }
    }
  });

  test('a folder of its own inside a shared one is Olympus\'s whole', () => {
    for (const dedicated of [`${home}/.local/share/olympus-whatsapp`, `${home}/whatsapp`, '/srv/olympus/whatsapp']) {
      expect(isDedicatedOlympusFolder(dedicated, { HOME: home }), dedicated).toBe(true);
      const context = contextFor({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: dedicated });
      expect(context.ownRoots, dedicated).toContain(dedicated);
      expect(decideLocalFilesPath(choose(home), `${dedicated}/anything.txt`, context), dedicated).toBe('denied');
    }
  });

  test('a Mac compares the shared bases without regard to case', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      expect(isDedicatedOlympusFolder('/users/JO/library/application support', { HOME: '/Users/jo' })).toBe(false);
      expect(isDedicatedOlympusFolder('/Users/jo/Library/Application Support/Olympus', { HOME: '/Users/jo' })).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  test('the layout names the moves it accepts, apart from the folders it always knows', () => {
    const own = olympusOwnLocations({ HOME: home, OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: `${home}/capture`, OLYMPUS_WHATSAPP_STATE_DIR: home }, {});
    expect(own.moved).toEqual([`${home}/capture`]);
    expect(own.fixed).not.toContain(`${home}/capture`);
    expect(olympusOwnRoots({ HOME: home, OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: `${home}/capture` })).toEqual(expect.arrayContaining(own.fixed));
  });
});

describe('4. a link does not carry a move past that rule', () => {
  /** A home with the shared folders in it, and a place for links. */
  function homeWithBases(): { base: string; home: string } {
    const base = tempBase();
    const home = join(base, 'home');
    for (const folder of ['.local/share', '.config', '.cache', '.local/state']) mkdirSync(join(home, folder), { recursive: true });
    mkdirSync(join(home, 'Documents'), { recursive: true });
    return { base, home };
  }

  test('a name that leads to a shared base protects nothing and excludes nothing', () => {
    const { base, home } = homeWithBases();
    const none = contextFor({ HOME: home }).ownRoots;
    for (const [name, target] of [['to-share', join(home, '.local', 'share')], ['to-config', join(home, '.config')], ['to-home', home], ['to-parent', base]] as const) {
      const link = join(base, name);
      symlinkSync(target, link);
      for (const writer of ['OLYMPUS_WHATSAPP_STATE_DIR', 'OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR']) {
        const context = contextFor({ HOME: home, [writer]: link });
        expect(context.ownRoots, `${writer}=${name}`).toEqual(none);
      }
    }
    const context = contextFor({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: join(base, 'to-share') });
    expect(decideLocalFilesPath(choose(home), join(home, '.local', 'share', 'other', 'notes.txt'), context)).toBe('content');
    expect(decideLocalFilesPath(choose(home), join(home, 'Documents', 'budget.txt'), context)).toBe('content');
  });

  test('a name for a dedicated folder is Olympus\'s under both spellings', () => {
    const { base, home } = homeWithBases();
    const real = join(home, 'olympus-capture');
    mkdirSync(real);
    const link = join(base, 'capture-link');
    symlinkSync(real, link);
    const context = contextFor({ HOME: home, OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: link });
    expect(context.ownRoots).toEqual(expect.arrayContaining([link, real]));
    // The walk sees real paths.
    expect(decideLocalFilesPath(choose(home), join(real, day), context)).toBe('denied');
  });

  test('the same holds when the home folder is itself reached through a link', () => {
    const { base, home } = homeWithBases();
    const homeLink = join(base, 'home-link');
    symlinkSync(home, homeLink);
    // Written with the real spelling, the shared base looks dedicated to the layout.
    const env = { HOME: homeLink, OLYMPUS_WHATSAPP_STATE_DIR: join(home, '.local', 'share') };
    expect(isDedicatedOlympusFolder(join(home, '.local', 'share'), env)).toBe(true);
    expect(olympusOwnLocations(env).moved).toContain(join(home, '.local', 'share'));
    const context = contextFor(env);
    expect(context.ownRoots).toEqual(contextFor({ HOME: homeLink }).ownRoots);
    expect(decideLocalFilesPath(choose(home), join(home, '.local', 'share', 'other', 'notes.txt'), context)).toBe('content');
  });
});

describe('a pass over home, with a Telegram spool moved to ~/capture', () => {
  let passes = 0;

  /** One pass over `home` chosen, as the connector runs it: which of `paths` the index then holds. */
  async function passOver(home: string, base: string, context: DefaultExclusionContext, paths: string[]): Promise<string[]> {
    passes += 1;
    const approval = choose(home);
    const store = createLocalFilesConnectorStore({
      HOME: join(base, `olympus-home-${passes}`),
      [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(base, 'no-exclusions.json'),
    }, { policy: defaultLocalFilesIngestionPolicy({ stillImagesRead: false }) });
    const hub = new WatchHub();
    cleanups.push(async () => { await hub.close(); store.close(); });
    const decide = (path: string) => decideLocalFilesPath(approval, path, context);
    const scope: LocalFilesContentScope = {
      generation: 'a'.repeat(64),
      revision: '11111111-2222-4333-8444-555555555555',
      assertCurrent() {},
      decide,
      snapshotDecider: () => decide,
      roots: () => localFilesRoots(approval, context),
    };
    const snapshotDir = join(base, `watch-${passes}`);
    mkdirSync(snapshotDir, { recursive: true });
    const handler = createLocalFilesProviderStoreSyncHandler({
      store, tierSet: localFilesTestTierSet(store), scope, volumes: new VolumeResolver(), snapshotDir, hub, ignore: watchIgnoreGlobs(context), pageSize: 50,
    });
    const out = await handler.pull({ approved_scope_key: `${LOCAL_FILES_POLICY_SOURCE}:${home}` });
    expect(out.receipt.counts.traversal_complete).toBe(1);
    return paths.filter((path) => store.activeIdentityForLocatorIfIndexed({
      provider: LOCAL_FILES_PROVIDER, accountScope: LOCAL_FILES_ACCOUNT_SCOPE, locatorUri: path,
    }) !== undefined);
  }

  test('indexes the person\'s files and none of the spool', async () => {
    const base = tempBase();
    const home = join(base, 'home');
    const theirs = [join(home, 'Documents', 'budget.txt')];
    const spool = [join(home, 'capture', day)];
    for (const path of [...theirs, ...spool]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'x');
    }
    const context = contextFor({ HOME: home, OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: join(home, 'capture') });
    expect(await passOver(home, base, context, [...theirs, ...spool])).toEqual(theirs);
  });
});

describe('5. what an earlier version indexed inside an own folder', () => {
  const generation = 'a'.repeat(64);
  const revision = '11111111-1111-4111-8111-111111111111';
  const home = '/home/jo';
  const secret = `${home}/.config/olympus/zzsecretfile.txt`;
  const nested = `${home}/.config/olympus/sources/x/zznestedfile.txt`;
  const budget = `${home}/Documents/zzbudgetfile.txt`;

  const rawFile = (path: string, text: string) => {
    const id = localFilesItemId(path);
    return {
      identity: {
        family: 'file' as const,
        provider: LOCAL_FILES_PROVIDER,
        accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
        providerItemId: id,
        providerFileId: id,
        localItemId: `${LOCAL_FILES_ACCOUNT_SCOPE}:${id}`,
        sourceVersion: 'v1',
      },
      mimeType: 'text/plain',
      content: { kind: 'text' as const, text },
      metadata: Object.freeze({ entryKind: 'file', deleted: false, name: path.slice(path.lastIndexOf('/') + 1), locatorUri: path, pathDisplay: path }),
      fetchedAt: '2026-10-24T10:00:00.000Z',
    };
  };
  const identityOf = (path: string) => rawFile(path, '').identity;

  /** Indexes `files` into `store` the way an earlier version did. */
  async function indexInto(store: LocalConnectorStore, files: Array<[string, string]>): Promise<void> {
    const items = files.map(([path, text]) => rawFile(path, text));
    const connector: SourceConnector = {
      id: 'local.files.before-the-rule', family: 'file', async authenticate() {},
      async *listItems() { yield { items, done: true }; },
      async fetchItem(id) { return items.find((item) => item.identity.localItemId === id)!; },
      classificationSignals() { return {}; },
    };
    await store.syncFromConnector(connector, { fetchContent: true, sourceScopeObservation: () => ({ accountGeneration: generation, scopeRevision: revision }) });
  }

  /** A store holding `files` the way an earlier version indexed them. */
  async function indexedStore(files: Array<[string, string]>): Promise<LocalConnectorStore> {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: LOCAL_FILES_CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    cleanups.push(() => store.close());
    await indexInto(store, files);
    return store;
  }

  const approved = (...keys: string[]) => ({
    sourceId: LOCAL_FILES_SOURCE_ID, status: 'approved' as const, accountGeneration: generation, revision,
    selections: keys.map((key) => ({ key, state: 'ingest' as 'ingest' | 'exclude' })), wholeAccount: false,
  });

  /** A search through the route a question takes, under the read scope the worker builds from the saved approval alone. */
  async function search(store: LocalConnectorStore, approval: ReturnType<typeof approved>, text: string) {
    const worker = createEmailSourceWorker({
      connectorStores: [store],
      connectorStoreReadScope: () => {
        const metadata = fileSourceScopeMetadataFilters(approval as never);
        if (!metadata.allowed) return { allowed: false as const };
        const content = fileSourceScopeContentFilters(approval as never);
        return {
          allowed: true as const,
          accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
          filters: metadata.filters,
          contentAllowed: content.allowed,
          ...(content.allowed && content.filters ? { contentFilters: content.filters } : {}),
        };
      },
    });
    cleanups.push(() => worker.close());
    const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ corpus_id: store.corpusId, query: text }),
    }));
    expect(response.status).toBe(200);
    return (await response.json() as { hits: unknown[] }).hits;
  }

  const present = (store: LocalConnectorStore, path: string): boolean => store.itemPresence(identityOf(path)).active;
  const ownContext = (extra: Env = {}, platform: NodeJS.Platform = 'linux') => contextFor({ HOME: home, ...extra }, {}, platform);

  test('are removed at start, and the rest of the index stays', async () => {
    const store = await indexedStore([[secret, 'zzsecretbody the session token'], [nested, 'zznestedbody'], [budget, 'zzbudgetbody the quarterly figures']]);
    const approval = approved(`${home}/.config/olympus`, `${home}/Documents`);
    // Before the clean-up the folder chosen by name is still read back.
    expect(await search(store, approval, 'zzsecretbody')).toHaveLength(1);

    const context = ownContext();
    expect(context.ownRoots).toContain(`${home}/.config/olympus`);
    const result = await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context }).run();

    expect(result).toEqual({ removed: 2, complete: true });
    expect(await search(store, approval, 'zzsecretbody')).toHaveLength(0);
    expect(await search(store, approval, 'zznestedfile')).toHaveLength(0);
    expect(present(store, secret)).toBe(false);
    expect(present(store, nested)).toBe(false);
    expect(await search(store, approval, 'zzbudgetbody')).toHaveLength(1);
    expect(present(store, budget)).toBe(true);
  });

  test('also when the own folder was the only folder chosen: there is no pass, and it is gone before the first search', async () => {
    const store = await indexedStore([[secret, 'zzsecretbody the session token'], [budget, 'zzbudgetbody']]);
    const approval = approved(`${home}/.config/olympus`);
    const context = ownContext();
    // No root is left to walk, so no pass would ever judge what is stored.
    expect(localFilesRoots(approval, context)).toEqual([]);
    expect(await search(store, approval, 'zzsecretbody')).toHaveLength(1);

    await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context }).run();

    expect(await search(store, approval, 'zzsecretbody')).toHaveLength(0);
    expect(present(store, secret)).toBe(false);
    // What no approval reaches is not the clean-up's business.
    expect(present(store, budget)).toBe(true);
  });

  test('judges each stored path with the case rules of its volume: a sibling that differs by case is the person\'s', async () => {
    const files: Array<[string, string]> = [
      [`${home}/capture/${day}`, 'zzspoolbody'],
      [`${home}/Capture/notes.txt`, 'zzsiblingbody'],
      [`${home}/CAPTURE/more.txt`, 'zzshoutingbody'],
    ];
    const env = { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: `${home}/capture` };

    // A volume that keeps case: `Capture` and `CAPTURE` are other folders.
    const keeping = await indexedStore(files);
    const caseKeeping = { ...ownContext(env), volumeIgnoresCase: () => false };
    expect(caseKeeping.ownRoots).toContain(`${home}/capture`);
    const first = await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(keeping), context: caseKeeping }).run();
    expect(first).toEqual({ removed: 1, complete: true });
    expect(present(keeping, `${home}/capture/${day}`)).toBe(false);
    expect(present(keeping, `${home}/Capture/notes.txt`)).toBe(true);
    expect(present(keeping, `${home}/CAPTURE/more.txt`)).toBe(true);
    const approval = approved(home);
    expect(await search(keeping, approval, 'zzsiblingbody')).toHaveLength(1);
    expect(await search(keeping, approval, 'zzshoutingbody')).toHaveLength(1);

    // A volume that ignores case: they are the same folder, and all go.
    const ignoring = await indexedStore(files);
    const caseIgnoring = { ...ownContext(env), volumeIgnoresCase: () => true };
    const second = await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(ignoring), context: caseIgnoring }).run();
    expect(second).toEqual({ removed: 3, complete: true });
    for (const [path] of files) expect(present(ignoring, path)).toBe(false);
  });

  test('keeps looking past a long run of case-different siblings that sort first', async () => {
    // The store lists by folder ignoring case, in name order: these 520 come before the spool.
    const siblings: Array<[string, string]> = Array.from({ length: 520 }, (_, index) => [`${home}/Capture/a${String(index).padStart(4, '0')}.txt`, `zzsibling${index}`]);
    const spool: [string, string] = [`${home}/capture/zspool.jsonl`, 'zzspoolbody'];
    const store = await indexedStore([...siblings, spool]);
    const context = { ...ownContext({ OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: `${home}/capture` }), volumeIgnoresCase: () => false };
    expect(await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context, pageSize: 50 }).run()).toEqual({ removed: 1, complete: true });
    expect(present(store, spool[0])).toBe(false);
    expect(siblings.every(([path]) => present(store, path))).toBe(true);
  });

  /** `count` case-different siblings that all sort before one own spool file, and that file. */
  const siblingsBeforeSpool = (count: number) => {
    const siblings: Array<[string, string]> = Array.from({ length: count }, (_, index) => [`${home}/Capture/a${String(index).padStart(4, '0')}.txt`, `zzsibling${index}`]);
    const spool: [string, string] = [`${home}/capture/z-secret.jsonl`, 'zzspoolsecret'];
    const context = { ...ownContext({ OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: `${home}/capture` }), volumeIgnoresCase: () => false };
    return { siblings, spool, context };
  };

  test('reaches an own file behind more siblings than one look can hold: the walk has no ceiling that ends it', async () => {
    const { siblings, spool, context } = siblingsBeforeSpool(40);
    const store = await indexedStore([...siblings, spool]);
    expect(await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context, pageSize: 6 }).run()).toEqual({ removed: 1, complete: true });
    expect(present(store, spool[0])).toBe(false);
    expect(siblings.every(([path]) => present(store, path))).toBe(true);
  });

  test('a run that stops among the siblings is not complete, and the next run goes on from where it stopped', async () => {
    const { siblings, spool, context } = siblingsBeforeSpool(40);
    const store = await indexedStore([...siblings, spool]);
    // Each run may read only 12 stored paths: from the start again, none would ever get past the siblings.
    const cleanup = createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context, pageSize: 6, maxScanned: 12 });
    const first = await cleanup.run();
    expect(first).toEqual({ removed: 0, complete: false });
    expect(present(store, spool[0])).toBe(true);
    const results = [first];
    while (!results.at(-1)!.complete && results.length < 8) results.push(await cleanup.run());
    expect(results.at(-1)).toEqual({ removed: 1, complete: true });
    expect(results.length).toBeLessThanOrEqual(5);
    expect(present(store, spool[0])).toBe(false);
    expect(siblings.every(([path]) => present(store, path))).toBe(true);
    // Done is done: nothing is asked of the store again.
    expect(await cleanup.run()).toEqual({ removed: 0, complete: true });
  });

  test('the store\'s page of a folder carries a position that continues exactly past the last row, ties included', async () => {
    // `~/capture/a` and `~/Capture/a` fold to the same key: the position must not skip the second.
    const files: Array<[string, string]> = [
      [`${home}/capture/a`, 'x1'], [`${home}/Capture/a`, 'x2'], [`${home}/capture/b`, 'x3'],
      [`${home}/Capture/c`, 'x4'], [`${home}/capture/d`, 'x5'], [`${home}/capture`, 'zzafilenamedlikethefolder'],
    ];
    const store = await indexedStore(files);
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      // One row a page: the two spellings of `a` are split across two pages.
      const page = store.pageActiveItemsUnderLocatorIfIndexed({ provider: LOCAL_FILES_PROVIDER, accountScope: LOCAL_FILES_ACCOUNT_SCOPE, locatorUri: `${home}/capture`, limit: 1, ...(after ? { after } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((item) => item.locatorUri));
      if (!page.next) break;
      after = page.next;
    }
    // Every row under the folder once, in order of the folded path; the folder's own name is not under it.
    expect([...seen].sort()).toEqual(files.map(([path]) => path).filter((path) => path !== `${home}/capture`).sort());
    expect(new Set(seen).size).toBe(seen.length);
    // One position, a longer page: the rest of the folder, and no `next`.
    const first = store.pageActiveItemsUnderLocatorIfIndexed({ provider: LOCAL_FILES_PROVIDER, accountScope: LOCAL_FILES_ACCOUNT_SCOPE, locatorUri: `${home}/capture`, limit: 2 });
    expect(first.next).toBeDefined();
    const rest = store.pageActiveItemsUnderLocatorIfIndexed({ provider: LOCAL_FILES_PROVIDER, accountScope: LOCAL_FILES_ACCOUNT_SCOPE, locatorUri: `${home}/capture`, limit: 50, after: first.next! });
    expect(rest.next).toBeUndefined();
    expect(rest.items).toHaveLength(seen.length - 2);
  });

  test('a file that is named like an own folder, apart from case, is never touched', async () => {
    const store = await indexedStore([[`${home}/Capture`, 'zzfilenamedlikeafolder'], [`${home}/capture/${day}`, 'zzspoolbody']]);
    const context = { ...ownContext({ OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: `${home}/capture` }), volumeIgnoresCase: () => false };
    await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context }).run();
    expect(present(store, `${home}/Capture`)).toBe(true);
    expect(present(store, `${home}/capture/${day}`)).toBe(false);
    expect(await search(store, approved(home), 'zzfilenamedlikeafolder')).toHaveLength(1);
  });

  test('an approval with a hundred exclusions still reads: the read scope is the saved approval alone', async () => {
    const store = await indexedStore([[budget, 'zzbudgetbody the quarterly figures'], [secret, 'zzsecretbody']]);
    const excluded = Array.from({ length: 100 }, (_, index) => ({ key: `${home}/Excluded/folder-${index}`, state: 'exclude' as const }));
    const approval = { ...approved(home), selections: [{ key: home, state: 'ingest' as const }, ...excluded] };
    const metadata = fileSourceScopeMetadataFilters(approval as never);
    if (!metadata.allowed) throw new Error('the scope must allow reading');
    // Exactly the approval's own exclusions: nothing of Olympus's is added, and a hundred is all a filter takes.
    expect(metadata.filters.locatorPathExcludedScopes).toHaveLength(100);
    expect(await search(store, approval, 'zzbudgetbody')).toHaveLength(1);
  });

  test('the worker\'s read scopes take no own folders, and the clean-up runs before it answers', () => {
    const server = readFileSync(new URL('../src/workers/email-source/server.ts', import.meta.url), 'utf8');
    // Read scopes come from the saved approval alone: no second argument.
    expect(server).not.toMatch(/fileSourceScope(?:Content|Metadata)Filters\([^()]*,/);
    expect(server).not.toContain('alwaysExcluded');
    const cleanup = server.indexOf('await localFilesInitialCleanup;');
    expect(cleanup).toBeGreaterThan(0);
    expect(cleanup).toBeLessThan(server.indexOf('const startServer = '));
    // And each pass asks again, so a clean-up cut short goes on, and starts only once no batch is in flight.
    const syncFactory = server.slice(server.indexOf('const localFilesSyncFor = '), server.indexOf('const localFilesApprovedScopePaths = '));
    expect(syncFactory).toContain('const ownRootsCleanup = localFilesOwnRootsCleanup;');
    expect(syncFactory).toContain('if (!ownRootsCleanup) return undefined;');
    expect(syncFactory).toContain('beforePull: async () => { await ownRootsCleanup.run(); await ownRootsCleanup.idle(); }');
    const mount = server.slice(server.indexOf('const mountLocalFiles = '), server.indexOf('const isLocalFilesTierStore = '));
    expect(mount).toContain('localFilesOwnRootsCleanup = createLocalFilesOwnRootsCleanup(');
    expect(mount).toContain('localFilesCleanupRecovery = createLocalFilesOwnRootsRecovery(');
    expect(mount).toContain('localFilesInitialCleanup = localFilesCleanupRecovery.initial;');
    expect(server).toContain('sourceId === LOCAL_FILES_SOURCE_ID && !localFilesCleanupRecovery?.ready()');
  });

  /** A real tier lane (its stores on disk) whose secure store holds `files`. */
  async function tierLaneHolding(files: Array<[string, string]>) {
    const base = tempBase();
    const env = { HOME: join(base, 'home'), XDG_DATA_HOME: join(base, 'data'), [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(base, 'no-exclusions.json') };
    const policy = defaultLocalFilesIngestionPolicy({ stillImagesRead: false });
    const secure = createLocalFilesConnectorStore(env, { policy });
    const lane = createLocalFilesTierLane({ secureStore: secure, env, policy });
    cleanups.push(() => { lane.internal.current()?.close(); lane.public.current()?.close(); secure.close(); });
    await indexInto(secure, files);
    return { secure, lane };
  }
  const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

  test('goes through the lane\'s tier set, and moves no folder\'s cursor', async () => {
    const { secure, lane } = await tierLaneHolding([[secret, 'zzsecretbody the session token'], [budget, 'zzbudgetbody']]);
    const runs: unknown[][] = [];
    const sync = lane.set.sync.bind(lane.set);
    lane.set.sync = (...args: Parameters<typeof sync>) => { runs.push(args.slice(2)); return sync(...args); };

    const result = await createLocalFilesOwnRootsCleanup({ tierSet: lane.set, context: ownContext() }).run();

    expect(result).toEqual({ removed: 1, complete: true });
    expect(runs).toEqual([[{ commitCursor: false, settle: false }]]);
    expect(present(secure, secret)).toBe(false);
    expect(present(secure, budget)).toBe(true);
    expect(lane.set.committedCursor(LOCAL_FILES_OWN_ROOTS_CLEANUP_CONNECTOR_ID)).toBeUndefined();
  });

  test('settles nothing else first: a backlog of owner overrides is no part of the start-up wait', async () => {
    const { secure, lane } = await tierLaneHolding([[secret, 'zzsecretbody the session token'], [budget, 'zzbudgetbody']]);
    // The tier-wide settlement reads every routed override of the set.
    let reads = 0;
    const listRoutedOverrides = lane.set.ledger.listRoutedOverrides.bind(lane.set.ledger);
    lane.set.ledger.listRoutedOverrides = () => { reads += 1; return listRoutedOverrides(); };

    expect(await createLocalFilesOwnRootsCleanup({ tierSet: lane.set, context: ownContext() }).run()).toEqual({ removed: 1, complete: true });
    expect(present(secure, secret)).toBe(false);
    expect(reads).toBe(0);

    // The lane's own run still settles, as it always did.
    await lane.set.sync({
      id: 'local.files.after', family: 'file', async authenticate() {},
      async *listItems() { yield { items: [], done: true }; },
      async fetchItem() { throw new Error('none'); }, classificationSignals() { return {}; },
    }, { placement: LOCAL_FILES_STORE_PLACEMENT, fetchContent: false });
    expect(reads).toBeGreaterThan(0);
  });

  test('the caller waits no longer than the time bound, even while a deletion is still running', async () => {
    const { secure, lane } = await tierLaneHolding([[secret, 'zzsecretbody the session token']]);
    const sync = lane.set.sync.bind(lane.set);
    lane.set.sync = async (...args: Parameters<typeof sync>) => { await sleep(700); return sync(...args); };
    const cleanup = createLocalFilesOwnRootsCleanup({ tierSet: lane.set, context: ownContext(), maxMs: 100 });

    const asked = Date.now();
    expect(await cleanup.run()).toEqual({ removed: 0, complete: false });
    expect(Date.now() - asked).toBeLessThan(450);

    // The deletion lands on its own, and the next run finds nothing left.
    await sleep(900);
    expect(present(secure, secret)).toBe(false);
    expect(await cleanup.run()).toEqual({ removed: 0, complete: true });
  });

  test('a pass that follows waits for a batch the bound released its caller from', async () => {
    const { secure, lane } = await tierLaneHolding([[secret, 'zzsecretbody the session token']]);
    const sync = lane.set.sync.bind(lane.set);
    let inFlight = false;
    lane.set.sync = async (...args: Parameters<typeof sync>) => {
      inFlight = true;
      try { await sleep(400); return await sync(...args); } finally { inFlight = false; }
    };
    const cleanup = createLocalFilesOwnRootsCleanup({ tierSet: lane.set, context: ownContext(), maxMs: 50 });

    expect(await cleanup.run()).toEqual({ removed: 0, complete: false });
    expect(inFlight).toBe(true);
    await cleanup.idle();
    expect(inFlight).toBe(false);
    expect(present(secure, secret)).toBe(false);
  });

  test('each provider pull waits for its cleanup barrier, including a repeated pass', async () => {
    const base = tempBase();
    const docs = join(base, 'docs');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'a.txt'), 'Synthetic user file');
    const store = await indexedStore([]);
    const approval = choose(docs);
    const decide = (path: string) => decideLocalFilesPath(approval, path, contextFor({ HOME: base }));
    const events: string[] = [];
    const scope: LocalFilesContentScope = {
      generation, revision, assertCurrent() { events.push('scope'); }, decide,
      snapshotDecider: () => decide, roots: () => localFilesRoots(approval),
    };
    let release: (() => void) | undefined;
    const handler = createLocalFilesProviderStoreSyncHandler({
      store, tierSet: localFilesTestTierSet(store), scope, volumes: new VolumeResolver(), snapshotDir: join(base, 'watch'),
      beforePull: async () => {
        events.push('cleanup-start');
        await new Promise<void>(resolve => { release = resolve; });
        events.push('cleanup-idle');
      },
    });
    for (let pass = 0; pass < 2; pass++) {
      events.length = 0;
      const pull = handler.pull({ approved_scope_key: `${LOCAL_FILES_POLICY_SOURCE}:${docs}` });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(events).toEqual(['cleanup-start']);
      release!();
      await pull;
      expect(events.slice(0, 2)).toEqual(['cleanup-start', 'cleanup-idle']);
    }
  });

  test('recovery never treats an incomplete result as ready and retries transient work', async () => {
    let calls = 0;
    const recovery = createLocalFilesOwnRootsRecovery({
      cleanup: { run: async () => ({ removed: 0, complete: ++calls >= 3 }), idle: async () => {} },
      stores: () => [], retryMs: 1, maxRetryMs: 4,
    });
    try {
      await recovery.initial;
      expect(recovery.ready()).toBe(false);
      const deadline = Date.now() + 1000;
      while (!recovery.ready() && Date.now() < deadline) await sleep(5);
      expect(recovery.ready()).toBe(true);
      expect(calls).toBe(3);
    } finally { recovery.close(); }
    expect(recovery.ready()).toBe(false);
  });

  test('persistent cleanup failures stay closed, report once and stop retrying at shutdown', async () => {
    let calls = 0;
    const messages: string[] = [];
    const recovery = createLocalFilesOwnRootsRecovery({
      cleanup: { run: async () => { calls++; return { removed: 0, complete: false }; }, idle: async () => {} },
      stores: () => [], retryMs: 1, maxRetryMs: 4, log: message => messages.push(message),
    });
    await recovery.initial;
    await sleep(20);
    expect(calls).toBeGreaterThan(1);
    expect(recovery.ready()).toBe(false);
    expect(messages).toHaveLength(1);
    recovery.close();
    const closedAt = calls;
    await sleep(20);
    expect(calls).toBe(closedAt);
    expect(recovery.ready()).toBe(false);
  });

  test('shutdown during an in-flight cleanup prevents later backfill or runners', async () => {
    let release!: () => void;
    const idle = new Promise<void>(resolve => { release = resolve; });
    let runs = 0, storeReads = 0;
    const recovery = createLocalFilesOwnRootsRecovery({
      cleanup: { run: async () => { runs++; return { removed: 0, complete: false }; }, idle: () => idle },
      stores: () => { storeReads++; return []; }, retryMs: 1,
    });
    await recovery.initial;
    await sleep(10);
    recovery.close();
    release();
    await sleep(10);
    expect(runs).toBe(1);
    expect(storeReads).toBe(0);
    expect(recovery.ready()).toBe(false);
  });

  test('is bounded by count, and what is left goes with the next pass of a chosen folder', async () => {
    const files: Array<[string, string]> = [1, 2, 3].map((n) => [`${home}/.config/olympus/zzown${n}.txt`, `zzownbody${n}`]);
    const store = await indexedStore(files);
    const context = ownContext();
    const cleanup = createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context, maxItems: 2, batchSize: 1 });
    expect(await cleanup.run()).toEqual({ removed: 2, complete: false });
    expect(files.filter(([path]) => present(store, path))).toHaveLength(1);

    // A pass of some other folder asks first.
    const base = tempBase();
    const docs = join(base, 'docs');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'a.txt'), 'x');
    const approval = choose(docs);
    const decide = (path: string) => decideLocalFilesPath(approval, path, contextFor({ HOME: base }));
    const scope: LocalFilesContentScope = {
      generation, revision, assertCurrent() {}, decide, snapshotDecider: () => decide, roots: () => localFilesRoots(approval),
    };
    const handler = createLocalFilesProviderStoreSyncHandler({
      store, tierSet: localFilesTestTierSet(store), scope, volumes: new VolumeResolver(), snapshotDir: join(base, 'watch'), beforePull: () => cleanup.run(),
    });
    await handler.pull({ approved_scope_key: `${LOCAL_FILES_POLICY_SOURCE}:${docs}` });

    expect(files.filter(([path]) => present(store, path))).toHaveLength(0);
    expect(await cleanup.run()).toEqual({ removed: 0, complete: true });
  });

  test('is bounded by time: a run whose time is up starts no batch, and the next run finishes', async () => {
    const files: Array<[string, string]> = [1, 2].map((n) => [`${home}/.config/olympus/zztimed${n}.txt`, `zztimedbody${n}`]);
    const store = await indexedStore(files);
    const context = ownContext();
    const stopped = await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context, maxMs: 0 }).run();
    expect(stopped).toEqual({ removed: 0, complete: false });
    expect(files.every(([path]) => present(store, path))).toBe(true);
    expect(await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context }).run()).toEqual({ removed: 2, complete: true });
  });

  test('a run whose time is up does not read the index at all', async () => {
    const store = await indexedStore([[secret, 'zzsecretbody']]);
    let looks = 0;
    const page = store.pageActiveItemsUnderLocatorIfIndexed.bind(store);
    store.pageActiveItemsUnderLocatorIfIndexed = (input) => { looks += 1; return page(input); };
    expect(await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context: ownContext(), maxMs: 0 }).run()).toEqual({ removed: 0, complete: false });
    expect(looks).toBe(0);
    expect(present(store, secret)).toBe(true);
  });

  test('the time bound holds while reading, not only between deletions: a slow index is left after the bound', async () => {
    const { siblings, spool, context } = siblingsBeforeSpool(60);
    const store = await indexedStore([...siblings, spool]);
    let looks = 0;
    const page = store.pageActiveItemsUnderLocatorIfIndexed.bind(store);
    store.pageActiveItemsUnderLocatorIfIndexed = (input) => {
      looks += 1;
      const until = Date.now() + 25;
      while (Date.now() < until) { /* a page that takes a while */ }
      return page(input);
    };
    const cleanup = createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context, pageSize: 2, maxMs: 80 });
    const asked = Date.now();
    const result = await cleanup.run();
    expect(result.complete).toBe(false);
    expect(looks).toBeGreaterThan(0);
    expect(looks).toBeLessThanOrEqual(6);
    expect(Date.now() - asked).toBeLessThan(400);
    // The run itself stops reading at the bound; it does not go on behind the caller.
    const atReturn = looks;
    await sleep(300);
    expect(looks).toBeLessThanOrEqual(atReturn + 1);
    expect(present(store, spool[0])).toBe(true);
  });

  test('waits, and says so, while the index of stored paths is still being prepared', async () => {
    const store = await indexedStore([[secret, 'zzsecretbody']]);
    store.locatorIdentityIndexReady = () => false;
    const told: string[] = [];
    expect(await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context: ownContext(), log: (message) => told.push(message) }).run())
      .toEqual({ removed: 0, complete: false });
    expect(told).toHaveLength(1);
    expect(present(store, secret)).toBe(true);
  });

  test('has nothing to do, and asks the store nothing, when there are no own folders', async () => {
    const store = await indexedStore([[secret, 'zzsecretbody']]);
    expect(await createLocalFilesOwnRootsCleanup({ tierSet: localFilesTestTierSet(store), context: { platform: 'linux' } }).run()).toEqual({ removed: 0, complete: true });
    expect(present(store, secret)).toBe(true);
  });
});
