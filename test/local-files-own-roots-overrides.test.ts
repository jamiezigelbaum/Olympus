// Files on this computer never index what Olympus itself writes, wherever an
// environment variable or the plugin config points a writer, and even what an
// earlier version indexed in a folder the person had chosen by name. These
// tests pin the cases a review found after the first version of that rule:
//  1. a Telegram spool moved by an environment variable or the plugin config;
//  2. the Mac's app and log folders under ~/Library;
//  3. an override that names a shared folder (~/.local/share) must not take the
//     unrelated files beside it;
//  4. an override that names the home folder still leaves the writer's own
//     files (and its spool) out;
//  5. items already indexed inside an own folder are never returned, and go.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configuredCaptureLocations } from '../src/core/config.ts';
import { isDedicatedOlympusFolder, olympusOwnLocations } from '../src/core/olympus-layout.ts';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { defaultLocalFilesIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { connectThisComputerSource } from '../src/core/this-computer.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  defaultExclusionContext,
  defaultExclusionForFolder,
  isInsideOwnRoot,
  isOwnPath,
  type DefaultExclusionContext,
} from '../src/workers/local-files/paths.ts';
import { createLocalFilesProviderStoreSyncHandler } from '../src/workers/local-files/provider-store-sync.ts';
import { createLocalFilesFolderScopeBrowser } from '../src/workers/local-files/scope-browser.ts';
import {
  LOCAL_FILES_ACCOUNT_SCOPE,
  LOCAL_FILES_POLICY_SOURCE,
  LOCAL_FILES_PROVIDER,
  LOCAL_FILES_SOURCE_ID,
  createScopeBoundLocalFilesContentScope,
  decideLocalFilesPath,
  localFilesRoots,
  type LocalFilesContentScope,
} from '../src/workers/local-files/scope.ts';
import {
  LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV,
  LOCAL_FILES_CORPUS_ID,
  createLocalFilesConnectorStore,
} from '../src/workers/local-files/store.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { WatchHub, watchIgnoreGlobs } from '../src/workers/local-files/watch-hub.ts';
import { FileSourceScopeAuthority, fileSourceScopeContentFilters, fileSourceScopeReadScope } from '../src/workers/source-scope-runtime.ts';

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

describe('1. a Telegram spool moved by an environment variable or the plugin config', () => {
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

describe('3. an override that names a shared folder', () => {
  const home = '/home/jo';
  const env = (override: string, extra: Env = {}): Env => ({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: override, ...extra });

  test('OLYMPUS_WHATSAPP_STATE_DIR=~/.local/share leaves the unrelated files beside it alone', () => {
    const context = contextFor(env(`${home}/.local/share`));
    expect(context.ownRoots).not.toContain(`${home}/.local/share`);
    expect(decideLocalFilesPath(choose(home), `${home}/.local/share/other/notes.txt`, context)).toBe('content');
    expect(decideLocalFilesPath(choose(home), `${home}/.local/share/notes.txt`, context)).toBe('content');
    // What the bridge writes there is still Olympus's.
    expect(decideLocalFilesPath(choose(home), `${home}/.local/share/session.db`, context)).toBe('denied');
    expect(decideLocalFilesPath(choose(home), `${home}/.local/share/spool/2026-10-24.jsonl`, context)).toBe('denied');
    expect(decideLocalFilesPath(choose(home), `${home}/.local/share/media/audio/clip.opus`, context)).toBe('denied');
    expect(decideLocalFilesPath(choose(home), `${home}/.local/share/connector-store.db`, context)).toBe('denied');
  });

  test('none of the shared bases is a whole own folder, and what is beside the writer\'s files stays the person\'s', () => {
    const bases = [
      `${home}/.local/share`, `${home}/.config`, `${home}/.local/state`, `${home}/.cache`,
      `${home}/Library`, `${home}/Library/Application Support`,
      // An ancestor of one of those, and of the home folder itself.
      `${home}/.local`, '/home', '/',
      // The XDG values, wherever the environment puts them.
      '/srv/xdg-data', '/srv/xdg-config', '/srv/xdg-state', '/srv/xdg-cache', '/run/user/1000',
    ];
    const xdg = {
      XDG_DATA_HOME: '/srv/xdg-data', XDG_CONFIG_HOME: '/srv/xdg-config', XDG_STATE_HOME: '/srv/xdg-state',
      XDG_CACHE_HOME: '/srv/xdg-cache', XDG_RUNTIME_DIR: '/run/user/1000',
    };
    for (const base of bases) {
      const context = contextFor(env(base, xdg));
      const inBase = (name: string): string => (base === '/' ? `/${name}` : `${base}/${name}`);
      expect(isDedicatedOlympusFolder(base, env(base, xdg)), base).toBe(false);
      expect(context.ownRoots, base).not.toContain(base);
      expect(isInsideOwnRoot(inBase('other/notes.txt'), context), base).toBe(false);
      expect(isOwnPath(inBase('other/notes.txt'), context), base).toBe(false);
      expect(isOwnPath(inBase('session.db'), context), base).toBe(true);
      expect(isOwnPath(inBase('spool/2026-10-24.jsonl'), context), base).toBe(true);
    }
  });

  test('a folder of its own inside a shared one is Olympus\'s whole', () => {
    for (const dedicated of [`${home}/.local/share/olympus-whatsapp`, `${home}/whatsapp`, '/srv/olympus/whatsapp']) {
      expect(isDedicatedOlympusFolder(dedicated, env(dedicated)), dedicated).toBe(true);
      const context = contextFor(env(dedicated));
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
});

describe('4. an override that names the home folder', () => {
  const day = '2026-10-24.jsonl';

  test('OLYMPUS_WHATSAPP_STATE_DIR=$HOME: the bridge\'s files and spool are Olympus\'s, the rest of home is not', () => {
    const home = join(tempBase(), 'home');
    const context = contextFor({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: home });
    expect(context.ownRoots).not.toContain(home);
    expect(context.ownRoots).toEqual(expect.arrayContaining([join(home, 'spool'), join(home, 'media')]));
    for (const approval of [choose(home), everything]) {
      for (const path of [
        join(home, 'spool', day),
        join(home, 'media', 'audio', 'clip.opus'),
        // Every name tools/whatsapp-bridge/main.go and the connector store give the files in its state folder.
        ...['session.db', 'session.db-wal', 'session.db-shm', 'session.db-journal', 'qr.txt', 'qr.png', 'qr.png.tmp',
          'native-service-readiness.json', 'pairing-status.json', '.pairing-status-123456', '.native-service-readiness.json.tmp789',
          'connector-store.db', 'connector-store-internal.db', 'connector-store.db-wal', 'connector-store-internal.db-shm'].map((name) => join(home, name)),
      ]) {
        expect(decideLocalFilesPath(approval, path, context), path).toBe('denied');
      }
      // The person's own files, including ones that only look alike.
      for (const name of ['Documents/budget.txt', 'session.txt', 'notes.db', 'spool.txt', 'qr-code.png', 'readiness.json', 'my-connector-store.db', 'media.txt']) {
        expect(decideLocalFilesPath(approval, join(home, name), context), name).toBe('content');
      }
    }
  });

  test('the live watch drops the same files and folders', () => {
    const home = join(tempBase(), 'home');
    const globs = watchIgnoreGlobs(contextFor({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: home }));
    expect(globs).toEqual(expect.arrayContaining([
      join(home, 'spool'), join(home, 'media'),
      join(home, 'session.db'), join(home, 'session.db-wal'), join(home, 'qr.txt'), join(home, 'qr.png'),
      join(home, 'native-service-readiness.json'), join(home, 'connector-store*.db'), join(home, 'connector-store*.db-wal'),
    ]));
    expect(globs).not.toContain(home);
  });

  test('a Telegram spool or gateway state at $HOME keeps to the writer\'s file names', () => {
    const home = join(tempBase(), 'home');
    const spool = contextFor({ HOME: home, OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: home });
    expect(spool.ownRoots).not.toContain(home);
    expect(decideLocalFilesPath(choose(home), join(home, day), spool)).toBe('denied');
    for (const name of ['notes.jsonl', '2026-10-24-notes.jsonl', '2026-10-24.json', 'state.json']) {
      expect(decideLocalFilesPath(choose(home), join(home, name), spool), name).toBe('content');
    }
    const gateway = contextFor({ HOME: home, OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: home });
    expect(gateway.ownRoots).not.toContain(home);
    for (const name of ['state.json', 'gateway.lock', 'backfill-requests.jsonl', 'native-service-readiness.json', '.state.json.tmp.4242']) {
      expect(decideLocalFilesPath(choose(home), join(home, name), gateway), name).toBe('denied');
    }
    for (const name of ['notes.json', 'my-state.json', day]) {
      expect(decideLocalFilesPath(choose(home), join(home, name), gateway), name).toBe('content');
    }
  });

  test('a folder above home is no more than home is', () => {
    const base = tempBase();
    const home = join(base, 'home');
    const context = contextFor({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: base });
    expect(context.ownRoots).not.toContain(base);
    expect(isOwnPath(join(base, 'session.db'), context)).toBe(true);
    expect(isOwnPath(join(home, 'session.db'), context)).toBe(false);
    expect(decideLocalFilesPath(choose(home), join(home, 'Documents', 'budget.txt'), context)).toBe('content');
  });

  test('a file name is compared the way its disk compares names', () => {
    const home = '/Users/jo';
    const mac = contextFor({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: home }, {}, 'darwin');
    const linux = contextFor({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: home }, {}, 'linux');
    expect(decideLocalFilesPath(choose(home), `${home}/Session.DB`, mac)).toBe('denied');
    expect(decideLocalFilesPath(choose(home), `${home}/Session.DB`, linux)).toBe('content');
    expect(decideLocalFilesPath(choose(home), `${home}/session.db`, linux)).toBe('denied');
  });

  test('the layout names them as files, never as the folder', () => {
    const home = '/home/jo';
    const own = olympusOwnLocations({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: home, OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: home }, {});
    expect(own.folders).not.toContain(home);
    expect(own.files.every((rule) => rule.dir === home)).toBe(true);
    expect(own.files.length).toBeGreaterThan(0);
  });
});

describe('a pass over home, with the writers pointed at home', () => {
  let passes = 0;

  /** One pass over `home` chosen, as the connector runs it: what the index then holds, by path. */
  async function passOver(home: string, base: string, context: DefaultExclusionContext, paths: string[]): Promise<string[]> {
    passes += 1;
    const approval = choose(home);
    const store = createLocalFilesConnectorStore({
      [LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV]: join(base, `store-${passes}.sqlite`),
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
      store, scope, volumes: new VolumeResolver(), snapshotDir, hub, ignore: watchIgnoreGlobs(context), pageSize: 50,
    });
    const out = await handler.pull({ approved_scope_key: `${LOCAL_FILES_POLICY_SOURCE}:${home}` });
    expect(out.receipt.counts.traversal_complete).toBe(1);
    return paths.filter((path) => store.activeIdentityForLocatorIfIndexed({
      provider: LOCAL_FILES_PROVIDER, accountScope: LOCAL_FILES_ACCOUNT_SCOPE, locatorUri: path,
    }) !== undefined);
  }

  function seed(base: string, files: string[]): void {
    for (const path of files) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'x');
    }
  }

  test('indexes the person\'s files and none of the bridge\'s', async () => {
    const base = tempBase();
    const home = join(base, 'home');
    const theirs = [join(home, 'Documents', 'budget.txt'), join(home, 'session.txt'), join(home, 'notes.db')];
    const bridges = [
      join(home, 'spool', '2026-10-24.jsonl'), join(home, 'media', 'audio', 'clip.opus'),
      join(home, 'session.db'), join(home, 'session.db-wal'), join(home, 'qr.png'), join(home, 'native-service-readiness.json'),
      join(home, 'connector-store.db'),
    ];
    seed(base, [...theirs, ...bridges]);
    const context = contextFor({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: home });
    const indexed = await passOver(home, base, context, [...theirs, ...bridges]);
    expect(indexed.sort()).toEqual([...theirs].sort());
  });

  test('indexes the person\'s files and none of a Telegram spool pointed at ~/capture', async () => {
    const base = tempBase();
    const home = join(base, 'home');
    const theirs = [join(home, 'Documents', 'budget.txt')];
    const spool = [join(home, 'capture', '2026-10-24.jsonl')];
    seed(base, [...theirs, ...spool]);
    const context = contextFor({ HOME: home, OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: join(home, 'capture') });
    expect(await passOver(home, base, context, [...theirs, ...spool])).toEqual(theirs);
  });
});

describe('5. what an earlier version indexed inside an own folder', () => {
  const generation = 'a'.repeat(64);
  const revision = '11111111-1111-4111-8111-111111111111';
  const home = '/home/jo';
  const secret = `${home}/.config/olympus/zzsecretfile.txt`;
  const budget = `${home}/Documents/zzbudgetfile.txt`;

  const rawFile = (path: string, text: string) => ({
    identity: {
      family: 'file' as const,
      provider: LOCAL_FILES_PROVIDER,
      accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
      providerItemId: `id:${path}`,
      providerFileId: `id:${path}`,
      localItemId: `${LOCAL_FILES_ACCOUNT_SCOPE}:id:${path}`,
      sourceVersion: 'v1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text' as const, text },
    metadata: Object.freeze({ entryKind: 'file', deleted: false, name: path.slice(path.lastIndexOf('/') + 1), locatorUri: path, pathDisplay: path }),
    fetchedAt: '2026-10-24T10:00:00.000Z',
  });

  async function indexedStore(): Promise<LocalConnectorStore> {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: LOCAL_FILES_CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    cleanups.push(() => store.close());
    const items = [rawFile(secret, 'zzsecretbody the session token'), rawFile(budget, 'zzbudgetbody the quarterly figures')];
    await store.syncFromConnector({
      id: 'local.files.before-the-rule', family: 'file', async authenticate() {},
      async *listItems() { yield { items, done: true }; },
      async fetchItem(id) { return items.find((item) => item.identity.localItemId === id)!; },
      classificationSignals() { return {}; },
    }, { fetchContent: true, sourceScopeObservation: () => ({ accountGeneration: generation, scopeRevision: revision }) });
    return store;
  }

  const approvals = {
    'the owner chose the folder by name': {
      sourceId: LOCAL_FILES_SOURCE_ID, status: 'approved' as const, accountGeneration: generation, revision,
      selections: [{ key: `${home}/.config/olympus`, state: 'ingest' as const }, { key: `${home}/Documents`, state: 'ingest' as const }],
      wholeAccount: false,
    },
    'the owner chose home': {
      sourceId: LOCAL_FILES_SOURCE_ID, status: 'approved' as const, accountGeneration: generation, revision,
      selections: [{ key: home, state: 'ingest' as const }],
      wholeAccount: false,
    },
    'the whole computer': {
      sourceId: LOCAL_FILES_SOURCE_ID, status: 'approved' as const, accountGeneration: generation, revision,
      selections: [], wholeAccount: true,
    },
  };

  /** A search through the route a question takes, under the read scope the worker builds for the approval. */
  async function search(store: LocalConnectorStore, approval: (typeof approvals)[keyof typeof approvals], alwaysExcluded: readonly string[], text: string) {
    const worker = createEmailSourceWorker({
      connectorStores: [store],
      connectorStoreReadScope: () => fileSourceScopeReadScope(approval as never, LOCAL_FILES_ACCOUNT_SCOPE, alwaysExcluded),
    });
    cleanups.push(() => worker.close());
    const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ corpus_id: store.corpusId, query: text }),
    }));
    expect(response.status).toBe(200);
    return (await response.json() as { hits: unknown[] }).hits;
  }

  const ownRoots = contextFor({ HOME: home }).ownRoots!;

  for (const [name, approval] of Object.entries(approvals)) {
    test(`${name}: a search, an answer or a listing no longer returns what was indexed under ~/.config/olympus`, async () => {
      const store = await indexedStore();
      expect(ownRoots).toContain(`${home}/.config/olympus`);
      // Before the rule it was returned, as the person's own file still is.
      expect(await search(store, approval, [], 'zzsecretbody')).toHaveLength(1);
      expect(await search(store, approval, ownRoots, 'zzsecretbody')).toHaveLength(0);
      expect(await search(store, approval, ownRoots, 'zzsecretfile')).toHaveLength(0);
      expect(await search(store, approval, ownRoots, 'zzbudgetbody')).toHaveLength(1);
      expect(await search(store, approval, ownRoots, 'zzbudgetfile')).toHaveLength(1);
      // The listing the status page counts uses the same filters.
      const scope = fileSourceScopeReadScope(approval as never, LOCAL_FILES_ACCOUNT_SCOPE, ownRoots);
      if (!scope.allowed) throw new Error('the scope must allow reading');
      expect(store.searchItems('zzsecretfile', 20, LOCAL_FILES_ACCOUNT_SCOPE, scope.filters)).toHaveLength(0);
      expect(store.searchItems('zzbudgetfile', 20, LOCAL_FILES_ACCOUNT_SCOPE, scope.filters)).toHaveLength(1);
    });
  }

  test('the content filter and the name filter both carry the folders', () => {
    const scope = fileSourceScopeReadScope(approvals['the owner chose home'] as never, LOCAL_FILES_ACCOUNT_SCOPE, ownRoots);
    if (!scope.allowed) throw new Error('the scope must allow reading');
    for (const filters of [scope.filters, scope.contentFilters]) {
      expect(filters?.locatorPathExcludedScopes).toEqual(expect.arrayContaining(ownRoots));
    }
    // Another source's scope is left as it was.
    const dropbox = fileSourceScopeContentFilters({ ...approvals['the owner chose home'], sourceId: 'dropbox.files', selections: [{ key: '/a', state: 'ingest' }] } as never);
    expect(dropbox).toMatchObject({ allowed: true });
    expect(JSON.stringify(dropbox)).not.toContain('olympus');
  });

  describe('and the next pass removes it from the index', () => {
    test('a folder chosen by name earlier is no root now, yet its items are deleted by the pass of another folder', async () => {
      const base = tempBase();
      const realHome = join(base, 'home');
      const ownDir = join(realHome, '.config', 'olympus');
      const docs = join(realHome, 'Documents');
      mkdirSync(ownDir, { recursive: true });
      mkdirSync(docs, { recursive: true });
      writeFileSync(join(ownDir, 'zzsecretfile.txt'), 'zzsecretbody');
      writeFileSync(join(docs, 'zzbudgetfile.txt'), 'zzbudgetbody');
      const registryPath = join(base, 'handles.json');
      const authority = new FileSourceScopeAuthority({ registryPath, readRegistry: () => ({ version: 1, handles: [] }) });
      connectThisComputerSource(registryPath, LOCAL_FILES_SOURCE_ID);
      const pending = authority.snapshot(LOCAL_FILES_SOURCE_ID);
      authority.approve({
        sourceId: LOCAL_FILES_SOURCE_ID,
        accountGeneration: pending.accountGeneration!,
        expectedRevision: pending.revision,
        selections: [{ key: ownDir, state: 'ingest' }, { key: docs, state: 'ingest' }],
        wholeAccount: false,
        explicitWholeAccountConfirmation: false,
      });
      const ref = authority.policyRef(LOCAL_FILES_SOURCE_ID)!;
      const store = createLocalFilesConnectorStore({
        [LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV]: join(base, 'store.sqlite'),
        [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(base, 'no-exclusions.json'),
      }, { policy: defaultLocalFilesIngestionPolicy({ stillImagesRead: false }) });
      cleanups.push(() => store.close());
      const isIndexed = (path: string): boolean => store.activeIdentityForLocatorIfIndexed({
        provider: LOCAL_FILES_PROVIDER, accountScope: LOCAL_FILES_ACCOUNT_SCOPE, locatorUri: path,
      }) !== undefined;
      const pull = async (context: DefaultExclusionContext, root: string) => createLocalFilesProviderStoreSyncHandler({
        store,
        scope: createScopeBoundLocalFilesContentScope({ authority, ref, context }),
        volumes: new VolumeResolver(),
        snapshotDir: join(base, 'watch'),
      }).pull({ approved_scope_key: `${LOCAL_FILES_POLICY_SOURCE}:${root}` });

      // Before the rule: the folder was a root like any other.
      const before: DefaultExclusionContext = { ...contextFor({ HOME: realHome }), home: realHome, ownRoots: [], ownFiles: [] };
      await pull(before, ownDir);
      await pull(before, docs);
      expect(isIndexed(join(ownDir, 'zzsecretfile.txt'))).toBe(true);
      expect(isIndexed(join(docs, 'zzbudgetfile.txt'))).toBe(true);

      // After it: the folder is no root, and a pass of the other one clears it out.
      const after: DefaultExclusionContext = { ...contextFor({ HOME: realHome }), home: realHome };
      expect(after.ownRoots).toContain(ownDir);
      const out = await pull(after, docs);
      expect(out.receipt.counts.items_tombstoned).toBeGreaterThanOrEqual(1);
      expect(isIndexed(join(ownDir, 'zzsecretfile.txt'))).toBe(false);
      expect(store.searchItems('zzsecretfile', 20, LOCAL_FILES_ACCOUNT_SCOPE)).toHaveLength(0);
      expect(isIndexed(join(docs, 'zzbudgetfile.txt'))).toBe(true);
    });
  });
});
