// Files on this computer never index what Olympus itself writes: its stores,
// the credential references and session secrets beside them, and the capture
// services' state. The list of those folders is one function in the layout
// module (`olympusOwnRoots`); these tests pin that it follows every writer's
// own resolution on each platform and layout, and that the scope decision, the
// picker and the live watch all honor it, even for a folder chosen by name.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { engineServicePaths, enginePaths } from '../src/core/engine-service.ts';
import { publishLinuxEngineReceipt, resolveLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';
import { mediaCacheDir, MEDIA_CACHE_DIR_ENV } from '../src/core/media-cache.ts';
import { defaultVeniceModelCatalogCachePath } from '../src/core/venice-model-catalog.ts';
import { whatsappBridgePathForPackage } from '../src/core/messaging-pairing.ts';
import {
  legacyCaptureDataRoot,
  legacyTelegramGatewayStateDir,
  legacyTelegramStoreRoot,
  legacyWhatsAppServiceStateDir,
  olympusDataRoot,
  olympusOwnRoots,
  whatsappStateDirFromValue,
} from '../src/core/olympus-layout.ts';
import { defaultOlympusConfigDir } from '../src/core/secret-store.ts';
import { whatsappStateDir } from '../src/core/pairing-session-paths.ts';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { defaultLocalFilesIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { defaultHandleRegistryPath } from '../src/workers/credential-broker/connected-handles.ts';
import { defaultCredentialHealthReportPath } from '../src/workers/credential-health.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  defaultExclusionContext,
  defaultExclusionForFolder,
  deepestDefaultExclusion,
  isInsideOwnRoot,
  type DefaultExclusionContext,
} from '../src/workers/local-files/paths.ts';
import { createLocalFilesProviderStoreSyncHandler } from '../src/workers/local-files/provider-store-sync.ts';
import { createLocalFilesFolderScopeBrowser } from '../src/workers/local-files/scope-browser.ts';
import {
  decideLocalFilesPath,
  fileSourceScopeLocalFilesPolicy,
  localFilesRoots,
  LOCAL_FILES_POLICY_SOURCE,
  type LocalFilesContentScope,
} from '../src/workers/local-files/scope.ts';
import { LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV, createLocalFilesConnectorStore } from '../src/workers/local-files/store.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { WatchHub, ignoreGlobsForRoot, watchIgnoreGlobs } from '../src/workers/local-files/watch-hub.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

type Env = Record<string, string | undefined>;

/** Runs `run` as another platform; the layout and the exclusion rules both read it. */
function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function tempBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'own-roots-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

interface Scenario {
  name: string;
  platform: NodeJS.Platform;
  env: Env;
  /** Folders Olympus writes in this layout, spelled out here rather than derived from the code under test. */
  roots: string[];
  /** Folders beside them that are not Olympus's. */
  others: string[];
}

function scenarios(base: string): Scenario[] {
  const home = join(base, 'home');
  const x = {
    data: join(base, 'xdg-data'),
    config: join(base, 'xdg-config'),
    state: join(base, 'xdg-state'),
    cache: join(base, 'xdg-cache'),
    runtime: join(base, 'xdg-run'),
    media: join(base, 'photos'),
  };
  const relocated = {
    HOME: home,
    XDG_DATA_HOME: x.data,
    XDG_CONFIG_HOME: x.config,
    XDG_STATE_HOME: x.state,
    XDG_CACHE_HOME: x.cache,
    XDG_RUNTIME_DIR: x.runtime,
    [MEDIA_CACHE_DIR_ENV]: x.media,
  };
  // What a writer that names the home itself puts there, whatever the environment says.
  const homeWriters = [
    join(home, '.olympus'),
    join(home, '.config', 'olympus'),
    join(home, '.local', 'share', 'olympus'),
    join(home, '.local', 'share', 'olympus', 'whatsapp-live'),
    join(home, '.local', 'share', 'openclaw', 'olympus'),
    join(home, '.local', 'state', 'olympus'),
    join(home, '.cache', 'olympus'),
  ];
  const homeOthers = [join(home, '.config', 'other'), join(home, '.local', 'share', 'other'), join(home, '.cache', 'other'), join(home, 'Documents')];
  const hosted = { OPENCLAW_STATE_DIR: join(home, '.openclaw') };
  return [
    {
      name: 'macOS',
      platform: 'darwin',
      env: { HOME: home },
      roots: [...homeWriters, join(home, '.local', 'share', 'openclaw', 'olympus', 'media-cache'), join(home, '.local', 'state', 'olympus', 'telegram-capture-gateway')],
      others: homeOthers,
    },
    {
      name: 'macOS with relocated XDG homes and media cache',
      platform: 'darwin',
      env: relocated,
      roots: [
        ...homeWriters,
        join(x.data, 'openclaw', 'olympus'),
        join(x.data, 'olympus'),
        x.media + '/olympus-media',
        join(x.state, 'olympus'),
        join(x.state, 'olympus', 'telegram-capture-gateway'),
        join(x.cache, 'olympus'),
      ],
      others: [...homeOthers, join(x.data, 'other'), join(x.state, 'other'), join(x.cache, 'other'), x.media],
    },
    {
      name: 'Linux hosted by OpenClaw',
      platform: 'linux',
      env: { HOME: home, ...hosted },
      roots: [...homeWriters, join(home, '.local', 'share', 'olympus-engine')],
      others: homeOthers,
    },
    {
      name: 'Linux hosted by OpenClaw with relocated XDG homes',
      platform: 'linux',
      env: { ...relocated, ...hosted },
      roots: [
        ...homeWriters,
        join(x.data, 'openclaw', 'olympus'),
        join(x.data, 'olympus'),
        join(x.data, 'olympus-engine'),
        join(x.config, 'olympus'),
        join(x.state, 'olympus'),
        join(x.cache, 'olympus'),
        join(x.runtime, 'olympus'),
        x.media + '/olympus-media',
      ],
      others: [...homeOthers, join(x.config, 'other'), join(x.data, 'other'), join(x.state, 'other'), join(x.cache, 'other'), join(x.runtime, 'other')],
    },
    {
      name: 'Linux receipt (standalone)',
      platform: 'linux',
      env: { HOME: home, OLYMPUS_STANDALONE: '1' },
      roots: [...homeWriters, join(home, '.local', 'share', 'olympus-engine')],
      others: homeOthers,
    },
    {
      name: 'Linux receipt (standalone) with relocated XDG homes',
      platform: 'linux',
      env: { ...relocated, OLYMPUS_STANDALONE: '1' },
      roots: [
        ...homeWriters,
        join(x.data, 'olympus'),
        join(x.data, 'olympus-engine'),
        join(x.config, 'olympus'),
        join(x.state, 'olympus'),
        join(x.cache, 'olympus'),
        join(x.runtime, 'olympus'),
        x.media + '/olympus-media',
      ],
      others: [...homeOthers, join(x.config, 'other'), join(x.data, 'other'), join(x.state, 'other'), join(x.cache, 'other'), join(x.runtime, 'other')],
    },
  ];
}

/** The folder and what could sit in it. */
const inside = (root: string): string[] => [join(root, 'a.txt'), join(root, 'sources', 'x.bookmarks', '1', 'stores', 'internal.sqlite')];

describe('every folder Olympus writes is off by default, on every platform and layout', () => {
  // One folder for all of them: the cases are built before any test runs.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'own-roots-layouts-')));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'home'), { recursive: true });
  for (const scenario of scenarios(base)) {
    test(scenario.name, () => withPlatform(scenario.platform, () => {
      const context = defaultExclusionContext(scenario.env);
      expect(context.platform).toBe(scenario.platform);
      const globs = watchIgnoreGlobs(context);
      for (const root of scenario.roots) {
        expect(olympusOwnRoots(scenario.env), root).toContain(root);
        expect(defaultExclusionForFolder(root, context), root).toBe('olympus_data');
        expect(deepestDefaultExclusion(root, context)?.reason, root).toBe('olympus_data');
        for (const path of inside(root)) {
          expect(deepestDefaultExclusion(path, context), path).toEqual({ path: root, reason: 'olympus_data' });
          expect(isInsideOwnRoot(path, context), path).toBe(true);
        }
        expect(globs, root).toContain(root);
      }
      for (const other of scenario.others) {
        expect(isInsideOwnRoot(other, context), other).toBe(false);
        expect(defaultExclusionForFolder(other, context), other).toBeUndefined();
      }
    }));
  }
});

describe('the list follows each writer, not a second copy of its rule', () => {
  // The paths the writers themselves resolve, for an environment and home they share.
  // Each must lie in one of the roots, for the layouts below.
  const within = (path: string, roots: readonly string[]): boolean =>
    roots.some((root) => path === root || path.startsWith(`${root}/`));

  test('macOS and OpenClaw-hosted writers', () => {
    const base = tempBase();
    const home = join(base, 'home');
    const x = { data: join(base, 'xdg-data'), config: join(base, 'xdg-config'), state: join(base, 'xdg-state'), cache: join(base, 'xdg-cache'), media: join(base, 'photos') };
    for (const env of [
      { HOME: home },
      { HOME: home, XDG_DATA_HOME: x.data, XDG_CONFIG_HOME: x.config, XDG_STATE_HOME: x.state, XDG_CACHE_HOME: x.cache, [MEDIA_CACHE_DIR_ENV]: x.media },
    ] as Env[]) {
      withPlatform('darwin', () => {
        const roots = olympusOwnRoots(env);
        const writers: Record<string, string> = {
          dataRoot: olympusDataRoot(env),
          legacyCapture: legacyCaptureDataRoot(env),
          legacyWhatsAppService: legacyWhatsAppServiceStateDir(env),
          legacyTelegramStores: legacyTelegramStoreRoot(env),
          telegramGatewayState: legacyTelegramGatewayStateDir(env),
          whatsappState: whatsappStateDir({ env }),
          mediaCache: mediaCacheDir(env),
          engineWorkerEnv: enginePaths(home).workerEnvPath,
          engineConfig: enginePaths(home).configPath,
          engineStatus: enginePaths(home).statusPath,
          engineModels: enginePaths(home).modelsDir,
          engineRemoteAccess: enginePaths(home).remoteAccessDir,
          veniceCache: defaultVeniceModelCatalogCachePath(env, home),
          whatsappBridge: whatsappBridgePathForPackage(join(import.meta.dir, '..'), { env }),
        };
        for (const [writer, path] of Object.entries(writers)) expect(within(path, roots), `${writer}: ${path}`).toBe(true);
      });
    }
  });

  test('writers that name the process owner\'s home themselves', () => {
    // handles.json, the credential health report and the secret store ignore the XDG homes.
    const env: Env = { HOME: homedir() };
    withPlatform('darwin', () => {
      const roots = olympusOwnRoots(env);
      expect(within(defaultHandleRegistryPath(), roots)).toBe(true);
      expect(within(defaultCredentialHealthReportPath(), roots)).toBe(true);
      expect(within(defaultOlympusConfigDir(env, 'darwin'), roots)).toBe(true);
    });
    // Even when XDG_CONFIG_HOME and XDG_STATE_HOME point elsewhere.
    const moved: Env = { HOME: homedir(), XDG_CONFIG_HOME: join(tmpdir(), 'cfg-elsewhere'), XDG_STATE_HOME: join(tmpdir(), 'state-elsewhere') };
    withPlatform('darwin', () => {
      const roots = olympusOwnRoots(moved);
      expect(within(defaultHandleRegistryPath(), roots)).toBe(true);
      expect(within(defaultCredentialHealthReportPath(), roots)).toBe(true);
    });
  });

  test('the Linux install\'s writers, with and without relocated XDG homes', () => {
    const base = tempBase();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const moved = {
      HOME: home,
      XDG_DATA_HOME: join(base, 'xdg-data'),
      XDG_CONFIG_HOME: join(base, 'xdg-config'),
      XDG_STATE_HOME: join(base, 'xdg-state'),
      XDG_CACHE_HOME: join(base, 'xdg-cache'),
      XDG_RUNTIME_DIR: join(base, 'xdg-run'),
    };
    for (const standalone of [false, true]) {
      for (const env of [{ HOME: home }, moved] as Env[]) {
        const launch: Env = { ...env, ...(standalone ? { OLYMPUS_STANDALONE: '1' } : { OPENCLAW_STATE_DIR: join(home, '.openclaw') }) };
        withPlatform('linux', () => {
          const roots = olympusOwnRoots(launch);
          const layout = resolveLinuxEngineLayout(launch);
          const engine = engineServicePaths({ platform: 'linux', env: launch });
          const writers: Record<string, string> = {
            configDir: layout.configDir,
            workerEnv: layout.workerEnvPath,
            secrets: layout.secretsPath,
            secretsKey: layout.secretsKeyPath,
            receipt: layout.receiptPath,
            secretStoreConfig: defaultOlympusConfigDir(launch, 'linux'),
            stateDir: layout.stateDir,
            cacheDir: layout.cacheDir,
            packageDir: layout.packageDir,
            dataDir: layout.dataDir,
            engineLog: engine.logPath,
            engineStatus: engine.statusPath,
            engineModels: engine.modelsDir,
            engineApp: engine.appDir,
            dataRoot: olympusDataRoot(launch),
            mediaCache: mediaCacheDir(launch),
          };
          if (layout.runtimeDir) writers.workerSocket = layout.workerSocketPath;
          for (const [writer, path] of Object.entries(writers)) expect(within(path, roots), `${writer}: ${path}`).toBe(true);
        });
      }
    }
  });

  // A Linux receipt records where the install put its folders; a shell whose XDG homes
  // changed since must not move the answer. Receipts are written and read only on Linux.
  test.skipIf(process.platform !== 'linux')('a Linux receipt outranks a shell whose XDG homes drifted', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'own-roots-receipt-')));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const env: Env = { HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_RUNTIME_DIR: join(home, 'run') };
    mkdirSync(env.XDG_RUNTIME_DIR!, { mode: 0o700 });
    publishLinuxEngineReceipt(resolveLinuxEngineLayout(env));
    const drift: Env = { ...env, XDG_DATA_HOME: join(home, 'different'), XDG_STATE_HOME: join(home, 'state-drift'), XDG_CACHE_HOME: join(home, 'cache-drift') };
    const roots = olympusOwnRoots(drift);
    expect(roots).toContain(join(home, 'data', 'olympus'));
    expect(roots).toContain(join(home, 'data', 'olympus-engine'));
    expect(roots).toContain(join(home, '.local', 'state', 'olympus'));
    expect(roots).toContain(join(home, '.cache', 'olympus'));
    // And the shell's own are still named: the writers that read the environment follow it.
    expect(roots).toContain(join(home, 'different', 'olympus'));
    expect(roots).toContain(join(home, 'state-drift', 'olympus'));
  });

  test('the media cache keeps the answers it always gave', () => {
    const home = join(tempBase(), 'home');
    expect(mediaCacheDir({ HOME: home })).toBe(join(olympusDataRoot({ HOME: home }), 'media-cache'));
    expect(mediaCacheDir({ HOME: home, [MEDIA_CACHE_DIR_ENV]: ' /cache/base ' })).toBe('/cache/base/olympus-media');
    expect(() => mediaCacheDir({ HOME: home, [MEDIA_CACHE_DIR_ENV]: 'relative/base' })).toThrow(/absolute/);
    expect(() => mediaCacheDir({ HOME: home, XDG_DATA_HOME: 'relative/data' })).toThrow(/absolute/);
  });

  test('a WhatsApp state location is the folder, or the session database inside it', () => {
    expect(whatsappStateDirFromValue(' /state/wa ')).toBe('/state/wa');
    expect(whatsappStateDirFromValue('/state/wa/session.db')).toBe('/state/wa');
    const env: Env = { HOME: '/home/layout-test', OLYMPUS_WHATSAPP_STATE_DIR: '/elsewhere/wa/session.db' };
    expect(olympusOwnRoots(env)).toContain('/elsewhere/wa');
    expect(whatsappStateDir({ env })).toBe('/elsewhere/wa');
  });

  test('a location that names no fixed place is left out', () => {
    // Linux refuses a relative XDG home outright (the data root cannot be worked out), so this is the Mac's.
    const roots = withPlatform('darwin', () => olympusOwnRoots({ HOME: '/home/jo', XDG_CONFIG_HOME: 'relative/config', XDG_CACHE_HOME: 'relative/cache' }));
    expect(roots.every((root) => root.startsWith('/'))).toBe(true);
    expect(roots).not.toContain('relative/config/olympus');
    expect(roots).toContain('/home/jo/.config/olympus');
  });
});

describe('the roots as the walk sees them', () => {
  test('a root reached through a link is excluded under both spellings, existing or not', () => {
    const base = tempBase();
    const home = join(base, 'home');
    const real = join(base, 'bigdisk', 'data');
    mkdirSync(real, { recursive: true });
    mkdirSync(home, { recursive: true });
    symlinkSync(join(base, 'bigdisk'), join(home, 'disk'));
    const env: Env = { HOME: home, XDG_DATA_HOME: join(home, 'disk', 'data') };
    const context = defaultExclusionContext(env);
    // Nothing exists below the link yet; the lexical and the real spelling are both named.
    const lexical = join(home, 'disk', 'data', 'openclaw', 'olympus');
    const resolved = join(real, 'openclaw', 'olympus');
    const everything = { selections: [{ key: base, state: 'ingest' as const }], wholeAccount: false };
    for (const root of [lexical, resolved]) {
      expect(defaultExclusionForFolder(root, context), root).toBe('olympus_data');
      expect(decideLocalFilesPath(everything, join(root, 'gmail-connector-store.sqlite'), context), root).toBe('denied');
      expect(watchIgnoreGlobs(context)).toContain(root);
    }
    // And a file beside the data folder is the person's.
    expect(decideLocalFilesPath(everything, join(real, 'notes.txt'), context)).toBe('content');
  });

  test('the home folder, or a folder above it, is never one of them', () => {
    const base = tempBase();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    for (const odd of [home, base, '/']) {
      const context = defaultExclusionContext({ HOME: home, OLYMPUS_WHATSAPP_STATE_DIR: odd });
      expect(context.ownRoots).not.toContain(odd);
      expect(decideLocalFilesPath({ selections: [{ key: home, state: 'ingest' }], wholeAccount: false }, join(home, 'Documents', 'a.txt'), context)).toBe('content');
    }
  });

  test('names compare the way their volume compares them', () => {
    const roots = ['/Users/jo/.config/olympus', '/Users/jo/.local/share/openclaw/olympus'];
    const darwin: DefaultExclusionContext = { home: '/Users/jo', syncedRoots: [], platform: 'darwin', ownRoots: roots };
    const linux: DefaultExclusionContext = { ...darwin, platform: 'linux' };
    const everything = { selections: [{ key: '/Users/jo', state: 'ingest' as const }], wholeAccount: false };
    expect(decideLocalFilesPath(everything, '/users/JO/.Config/Olympus/handles.json', darwin)).toBe('denied');
    expect(defaultExclusionForFolder('/Users/jo/.CONFIG/OLYMPUS', darwin)).toBe('olympus_data');
    // A case-sensitive file system: another spelling is another folder.
    expect(decideLocalFilesPath(everything, '/Users/jo/.Config/Olympus/handles.json', linux)).toBe('content');
    expect(defaultExclusionForFolder('/Users/jo/.config/olympus', linux)).toBe('olympus_data');
    // A disk whose format is known overrides the platform's usual one.
    const sensitiveDisk: DefaultExclusionContext = { ...darwin, volumeIgnoresCase: () => false };
    expect(decideLocalFilesPath(everything, '/Users/jo/.Config/Olympus/handles.json', sensitiveDisk)).toBe('content');
    expect(decideLocalFilesPath(everything, '/Users/jo/.config/olympus/handles.json', sensitiveDisk)).toBe('denied');
  });
});

describe('a folder chosen by name is still not read', () => {
  const darwin: DefaultExclusionContext = {
    home: '/Users/jo',
    syncedRoots: [],
    platform: 'darwin',
    ownRoots: ['/Users/jo/.config/olympus', '/Users/jo/.local/share/openclaw/olympus'],
  };
  const choose = (...keys: string[]) => ({ selections: keys.map((key) => ({ key, state: 'ingest' as const })), wholeAccount: false });

  test('whatever is chosen above, at, or below it, and under the whole computer', () => {
    for (const approval of [
      choose('/Users/jo'),
      choose('/Users/jo/.config'),
      choose('/Users/jo/.config/olympus'),
      choose('/Users/jo/.config/olympus/inner'),
      { selections: [], wholeAccount: true },
    ]) {
      expect(decideLocalFilesPath(approval, '/Users/jo/.config/olympus/handles.json', darwin)).toBe('denied');
      expect(decideLocalFilesPath(approval, '/Users/jo/.config/olympus/inner/a.txt', darwin)).toBe('denied');
      expect(decideLocalFilesPath(approval, '/Users/jo/.local/share/openclaw/olympus/gmail-connector-store.sqlite', darwin)).toBe('denied');
    }
    // The person's own folders next to them are read.
    expect(decideLocalFilesPath(choose('/Users/jo/.config'), '/Users/jo/.config/other/app.conf', darwin)).toBe('content');
    expect(decideLocalFilesPath({ selections: [], wholeAccount: true }, '/Users/jo/Documents/a.txt', darwin)).toBe('content');
  });

  test('turning on another folder that is off by default works as it did', () => {
    const approval = choose('/Users/jo', '/Users/jo/Code/app/node_modules');
    expect(decideLocalFilesPath(approval, '/Users/jo/Code/app/node_modules/pkg/index.js', darwin)).toBe('content');
    expect(decideLocalFilesPath(choose('/Users/jo/Library/Mobile Documents'), '/Users/jo/Library/Mobile Documents/a.txt', darwin)).toBe('content');
  });

  test('a saved choice inside one is no root: nothing is listed, scheduled or watched for it', () => {
    const approval = { selections: [
      { key: '/Users/jo/.config/olympus', state: 'ingest' as const },
      { key: '/Users/jo/.config/olympus/inner', state: 'metadata_only' as const },
      { key: '/Users/jo/.config', state: 'ingest' as const },
      { key: '/Users/jo/Documents', state: 'ingest' as const },
    ], wholeAccount: false };
    expect(localFilesRoots(approval, darwin).map((root) => root.scopePath)).toEqual(['/Users/jo/.config', '/Users/jo/Documents']);
    // The ones that do not know of the roots keep every choice, as they did.
    expect(localFilesRoots(approval).map((root) => root.scopePath)).toHaveLength(4);
    const policy = fileSourceScopeLocalFilesPolicy(
      defaultLocalFilesIngestionPolicy({ stillImagesRead: false }),
      { sourceId: 'local.files', status: 'approved', ...approval } as never,
      darwin,
    );
    expect(policy.roots.map((root) => root.path)).toEqual(['/Users/jo/.config', '/Users/jo/Documents']);
  });
});

describe('the live watch', () => {
  test('never reports Olympus\'s folders, and a watch above one keeps ignoring it', () => {
    const roots = ['/Users/jo/.config/olympus', '/Users/jo/.local/share/openclaw/olympus', '/elsewhere/data/olympus'];
    const context: DefaultExclusionContext = { home: '/Users/jo', syncedRoots: [], platform: 'darwin', ownRoots: roots };
    const globs = watchIgnoreGlobs(context);
    for (const root of roots) expect(globs).toContain(root);
    // Today's home-relative entries stay for an install whose environment has changed.
    for (const old of ['/Users/jo/.olympus', '/Users/jo/.openclaw', '/Users/jo/.local/share/openclaw']) expect(globs).toContain(old);
    // Watching home, or the folder holding the data folder, drops none of them.
    expect(ignoreGlobsForRoot(globs, '/Users/jo')).toEqual(expect.arrayContaining(roots));
    expect(ignoreGlobsForRoot(globs, '/Users/jo/.local/share/openclaw')).toContain('/Users/jo/.local/share/openclaw/olympus');
    expect(ignoreGlobsForRoot(globs, '/elsewhere/data')).toContain('/elsewhere/data/olympus');
  });
});

describe('the folder picker', () => {
  function pickerHome() {
    const base = tempBase();
    const home = join(base, 'home');
    for (const dir of ['Documents', '.config/olympus/inner', '.config/other', '.local/share/openclaw/olympus/sources', '.local/share/other']) {
      mkdirSync(join(home, dir), { recursive: true });
    }
    const volumes = new VolumeResolver({
      platform: 'darwin',
      home,
      readMounts: () => '/dev/disk3s1s1 on / (apfs, local)',
      diskutilPlist: () => '<key>VolumeUUID</key><string>AAAAAAAA-1111-2222-3333-444444444444</string>',
    });
    const context: DefaultExclusionContext = { ...defaultExclusionContext({ HOME: home }), home, platform: 'darwin', syncedRoots: [] };
    return { home, browser: createLocalFilesFolderScopeBrowser({ volumes, context, home }) };
  }

  test('shows Olympus\'s own folders with the reason, and offers no way to choose or open them', async () => {
    const f = pickerHome();
    const page = await f.browser.browse({ parentKey: join(f.home, '.config') });
    const byName = new Map(page.nodes.map((node) => [node.name, node]));
    expect(byName.get('olympus')).toMatchObject({
      selectable: false,
      has_children: false,
      excluded_by_default: true,
      default_exclusion_reason: 'Olympus\'s own data',
    });
    expect(byName.get('other')).toMatchObject({ selectable: true, has_children: true });
    expect(byName.get('other')?.excluded_by_default).toBeUndefined();
    // The data folder, below its own parent.
    const share = await f.browser.browse({ parentKey: join(f.home, '.local', 'share', 'openclaw') });
    expect(share.nodes.find((node) => node.name === 'olympus')).toMatchObject({ selectable: false, excluded_by_default: true });
    // Even when asked for what is inside one, nothing in it can be chosen.
    const within = await f.browser.browse({ parentKey: join(f.home, '.config', 'olympus') });
    expect(within.nodes.map((node) => [node.name, node.selectable, node.default_exclusion_reason])).toEqual([['inner', false, 'Olympus\'s own data']]);
  });

  test('refuses a choice of one, or of a folder inside it, and says why; skipping one and choosing above are saved', async () => {
    const f = pickerHome();
    const reason = /Olympus's own data is never indexed/;
    await expect(f.browser.validateSelections([{ key: join(f.home, '.config', 'olympus'), state: 'ingest' }])).rejects.toThrow(reason);
    await expect(f.browser.validateSelections([{ key: join(f.home, '.config', 'olympus', 'inner'), state: 'metadata_only' }])).rejects.toThrow(reason);
    await expect(f.browser.validateSelections([{ key: join(f.home, '.local', 'share', 'openclaw', 'olympus'), state: 'ingest' }])).rejects.toThrow(reason);
    await expect(f.browser.validateSelections([{ key: join(f.home, '.config', 'olympus'), state: 'exclude' }])).resolves.toHaveLength(1);
    await expect(f.browser.validateSelections([
      { key: f.home, state: 'ingest' },
      { key: join(f.home, '.config'), state: 'ingest' },
      { key: join(f.home, '.config', 'other'), state: 'ingest' },
    ])).resolves.toHaveLength(3);
  });
});

describe('a pass over the person\'s home folder', () => {
  let passes = 0;
  /** Builds a home folder with the person's files and Olympus's, where its writers fix them and where the environment moved them. */
  function seed() {
    const base = tempBase();
    const home = join(base, 'home');
    // The person's files, and a folder of the same kind that is not Olympus's.
    const theirs: Array<[string, string]> = [
      [join(home, 'Documents', 'quarterly-budget.txt'), 'alpha'],
      [join(home, '.config', 'other', 'otherapp-settings.txt'), 'bravo'],
    ];
    // Olympus's, where its writers fix them under the home.
    const olympus: Array<[string, string]> = [
      [join(home, '.config', 'olympus', 'handles.json'), 'zzconfig'],
      [join(home, '.config', 'olympus', 'worker.env'), 'zzworkerenv'],
      [join(home, '.local', 'state', 'olympus', 'lifecycle', 'zzstate.json'), 'zzstate'],
      [join(home, '.local', 'share', 'olympus', 'whatsapp-live', 'zzwhatsapp.txt'), 'zzwhatsapp'],
      [join(home, '.local', 'share', 'openclaw', 'olympus', 'zzdatastore.txt'), 'zzdata'],
    ];
    // And where the environment moved them, inside the folder the person chose.
    const moved = {
      data: join(home, 'xdg-data'),
      config: join(home, 'xdg-config'),
      state: join(home, 'xdg-state'),
      cache: join(home, 'xdg-cache'),
    };
    const olympusMoved: Array<[string, string]> = [
      [join(moved.data, 'openclaw', 'olympus', 'zzmoveddata.txt'), 'zzmoveddata'],
      [join(moved.data, 'olympus', 'telegram', 'zzmovedsession.txt'), 'zzmovedsession'],
      [join(moved.config, 'olympus', 'zzmovedconfig.txt'), 'zzmovedconfig'],
      [join(moved.state, 'olympus', 'telegram-capture-gateway', 'zzmovedgateway.txt'), 'zzmovedgateway'],
      [join(moved.cache, 'olympus', 'zzmovedcache.txt'), 'zzmovedcache'],
    ];
    const movedOther: Array<[string, string]> = [[join(moved.config, 'other', 'movedother-settings.txt'), 'movedother']];
    for (const [path, content] of [...theirs, ...olympus, ...olympusMoved, ...movedOther]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    const env: Env = {
      HOME: home,
      XDG_DATA_HOME: moved.data,
      XDG_CONFIG_HOME: moved.config,
      XDG_STATE_HOME: moved.state,
      XDG_CACHE_HOME: moved.cache,
    };
    const context: DefaultExclusionContext = { ...defaultExclusionContext(env), syncedRoots: [] };
    return { base, home, context, olympusNames: [...olympus, ...olympusMoved].map(([path]) => path.slice(path.lastIndexOf('/') + 1)) };
  }

  /** One pass over `rootKey` under `approval`, as the connector runs it; returns what the index then holds by name. */
  async function pass(
    f: ReturnType<typeof seed>,
    approval: { selections: Array<{ key: string; state: 'ingest' | 'metadata_only' | 'exclude' }>; wholeAccount: boolean },
    rootKey: string,
    knownRoots: DefaultExclusionContext | undefined,
  ) {
    passes += 1;
    const store: LocalConnectorStore = createLocalFilesConnectorStore({
      [LOCAL_FILES_CONNECTOR_STORE_DB_PATH_ENV]: join(f.base, `store-${passes}.sqlite`),
      [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(f.base, 'no-exclusions.json'),
    }, { policy: defaultLocalFilesIngestionPolicy({ stillImagesRead: false }) });
    const hub = new WatchHub();
    cleanups.push(async () => { await hub.close(); store.close(); });
    const decide = (path: string) => decideLocalFilesPath(approval, path, f.context);
    const scope: LocalFilesContentScope = {
      generation: 'a'.repeat(64),
      revision: '11111111-2222-4333-8444-555555555555',
      assertCurrent() {},
      decide,
      snapshotDecider: () => decide,
      roots: () => localFilesRoots(approval, knownRoots),
    };
    const snapshotDir = join(f.base, `watch-${passes}`);
    mkdirSync(snapshotDir, { recursive: true });
    const handler = createLocalFilesProviderStoreSyncHandler({
      store, scope, volumes: new VolumeResolver(), snapshotDir, hub, ignore: watchIgnoreGlobs(f.context), pageSize: 50,
    });
    const out = await handler.pull({ approved_scope_key: `${LOCAL_FILES_POLICY_SOURCE}:${rootKey}` });
    const indexed = (query: string): string[] => store.searchItems(query, 50, 'this_computer').map((row) => String(row.title ?? '')).sort();
    return { out, indexed, everyName: new Set(['txt', 'json', 'env'].flatMap((query) => indexed(query))) };
  }

  const words = ['handles', 'worker', 'zzstate', 'zzwhatsapp', 'zzdatastore', 'zzmoveddata', 'zzmovedsession', 'zzmovedconfig', 'zzmovedgateway', 'zzmovedcache'];

  test('indexes their files and none of Olympus\'s', async () => {
    const f = seed();
    const run = await pass(f, { selections: [{ key: f.home, state: 'ingest' }], wholeAccount: false }, f.home, f.context);
    expect(run.out.receipt.counts.traversal_complete).toBe(1);
    expect(run.indexed('quarterly')).toEqual(['quarterly-budget.txt']);
    expect(run.indexed('otherapp')).toEqual(['otherapp-settings.txt']);
    expect(run.indexed('movedother')).toEqual(['movedother-settings.txt']);
    // Every file name the index holds, by the extensions the files carry.
    expect(run.everyName.has('quarterly-budget.txt')).toBe(true);
    for (const name of f.olympusNames) expect(run.everyName.has(name), name).toBe(false);
    for (const word of words) expect(run.indexed(word), word).toEqual([]);
  });

  test('a pass over one of them, chosen by name, reads none of it', async () => {
    const f = seed();
    // Handed straight to the connector, as a choice saved before it was refused would be.
    for (const folder of [join(f.home, '.config', 'olympus'), join(f.home, '.local', 'share', 'openclaw', 'olympus'), join(f.home, 'xdg-data', 'olympus')]) {
      const run = await pass(f, { selections: [{ key: folder, state: 'ingest' }], wholeAccount: false }, folder, undefined);
      expect(run.everyName.size, folder).toBe(0);
    }
  });
});
