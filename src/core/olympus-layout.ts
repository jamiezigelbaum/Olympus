/**
 * Where Olympus keeps its data: the one module that computes the data root.
 *
 * Every source store, ledger and shared file lives under the data root, and a
 * module that needs one asks here instead of rebuilding the expression
 * (docs/design/source-storage.md, step 1). The functions return today's paths
 * and move nothing. Locations that disagree with the data root today are named
 * below as legacy, so the migration into account folders (step 4) has one
 * place to read them from.
 *
 * Deliberately free of SQLite and worker imports, directly and through
 * linux-engine-layout.ts: the dashboard's Unpair path and the CLI-side
 * lifecycle module both resolve through it.
 */
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveLinuxEngineLayout, standaloneLinuxDataDir } from './linux-engine-layout.ts';

export type LayoutEnv = Record<string, string | undefined>;

/** The home the environment names, else the process owner's. */
export function layoutHome(env: LayoutEnv = process.env): string {
  return env.HOME?.trim() || homedir();
}

/** `$XDG_DATA_HOME`, else `<home>/.local/share`. */
export function xdgDataHome(env: LayoutEnv = process.env): string {
  return env.XDG_DATA_HOME?.trim() || join(layoutHome(env), '.local', 'share');
}

/**
 * The data root: the standalone Linux engine's receipt `dataDir`, else
 * `<XDG data home>/openclaw/olympus` (macOS and OpenClaw-hosted).
 */
export function olympusDataRoot(env: LayoutEnv = process.env): string {
  const standalone = standaloneLinuxDataDir(env);
  if (standalone) return standalone;
  // A relative XDG_DATA_HOME is returned as given, as each resolver did
  // before; callers that refuse one (remote access) check for themselves.
  return join(xdgDataHome(env), 'openclaw', 'olympus');
}

/**
 * A path under the data root. Only this module composes one
 * (`test/data-path-guard.test.ts`): every other module asks for a file by
 * what it is (`sharedDataPath`, `accountStorePath`, `accountRawPath`, ...).
 */
function olympusDataPath(env: LayoutEnv, ...segments: string[]): string {
  return join(olympusDataRoot(env), ...segments);
}

/**
 * The files and folders in the data root that no one account owns
 * (docs/design/source-storage.md, "Shared files"), by what each is. Their
 * names never change; a shared file that keys rows by source has a forget
 * step (core/source-forget-registry.ts).
 */
export const SHARED_DATA_FILES = {
  registry: 'registry.json',
  'data-owner-lock': 'data-owner.lock',
  'remote-connections': 'remote-connections.sqlite',
  'source-dashboard': 'source-dashboard.sqlite',
  'source-scheduler': 'source-scheduler.sqlite',
  'source-watches': 'source-watches.sqlite',
  'file-extraction-jobs': 'file-extraction-jobs.sqlite',
  'ingestion-doctor-state': 'source-ingestion-doctor-state.json',
  'embedding-ledger': 'embedding-ledger.jsonl',
  'classification-ledger': 'classification-ledger.jsonl',
  'answer-latency': 'source-answer-latency.jsonl',
  'x-usage': 'x-bookmarks-api-usage.sqlite',
  'readwise-request-budget': 'readwise-daily-request-budget.json',
  'gmail-request-budget': 'gmail-daily-request-budget.json',
  'google-drive-request-budget': 'google-drive-daily-request-budget.json',
  'credential-broker-state': 'credential-broker-state.json',
  // Beside the remote connections, where the relay's private questions wait.
  'waiting-private-questions': 'waiting-private-questions.sqlite',
  'tier-migration': 'tier-migration',
  models: 'models',
  'built-in-embedding': 'models/built-in-embedding',
  'built-in-reasoning': 'models/built-in-reasoning',
  'built-in-transcription': 'models/built-in-transcription',
} as const;

export type SharedDataFile = keyof typeof SHARED_DATA_FILES;

/** One shared file or folder of the data root, by what it is. */
export function sharedDataPath(name: SharedDataFile, env: LayoutEnv = process.env): string {
  return olympusDataPath(env, SHARED_DATA_FILES[name]);
}

/**
 * Every folder under a home that Olympus claims as its own by its default
 * name (settings, data, capture, state, cache, logs), whatever the
 * environment says: the lexical fence a delete outside the data root checks.
 */
export function olympusHomeRoots(home: string): string[] {
  return [
    join(home, '.olympus'),
    join(home, '.config', 'olympus'),
    join(home, '.local', 'share', 'olympus'),
    join(home, '.local', 'share', 'openclaw', 'olympus'),
    join(home, '.local', 'state', 'olympus'),
    join(home, '.cache', 'olympus'),
    join(home, 'Library', 'Logs', 'Olympus'),
  ];
}

/**
 * Legacy: `<XDG data home>/olympus`, outside the data root. The WhatsApp
 * bridge's state directory and Telegram's capture spool live here today.
 * Nothing new goes here; step 4 moves them into their account folders.
 */
export function legacyCaptureDataRoot(env: LayoutEnv = process.env): string {
  return join(xdgDataHome(env), 'olympus');
}

/**
 * Legacy: the WhatsApp capture service's default state directory. It ignores
 * `XDG_DATA_HOME`, while pairing and the worker's readers honor it
 * (`legacyCaptureDataRoot`), so with a non-default `XDG_DATA_HOME` they
 * disagree. Kept exactly, `HOME` untrimmed included; step 4 moves both into
 * the account folder.
 */
export function legacyWhatsAppServiceStateDir(env: LayoutEnv = process.env): string {
  return join(env.HOME ?? homedir(), '.local', 'share', 'olympus', 'whatsapp-live');
}

/**
 * Legacy: the state folder scripts/whatsapp-live-sync.ts has always used (a cron
 * job's, not the worker's): `OLYMPUS_WHATSAPP_STATE_DIR` or `<home>/.local/share/olympus/whatsapp-live`.
 * It reads no other variable (`XDG_DATA_HOME` and every spool or store override
 * included), so an install that relocates the data folder does not move it.
 * Kept exactly, with the home as the OS reports it, not `env.HOME`.
 */
export function legacyWhatsAppLiveSyncStateDir(env: LayoutEnv = process.env, homeDir: string = homedir()): string {
  return env.OLYMPUS_WHATSAPP_STATE_DIR?.trim() || join(homeDir, '.local', 'share', 'olympus', 'whatsapp-live');
}

/** Where scripts/whatsapp-live-sync.ts has always kept a `legacy` account's spool and store: inside its own state folder. */
export function legacyWhatsAppLiveSyncPaths(env: LayoutEnv = process.env, homeDir: string = homedir()): { spoolDir: string; dbPath: string } {
  const stateDir = legacyWhatsAppLiveSyncStateDir(env, homeDir);
  return { spoolDir: join(stateDir, 'spool'), dbPath: join(stateDir, 'connector-store.db') };
}

/** The WhatsApp bridge's linked-device session, in its state folder. */
export const WHATSAPP_SESSION_FILE = 'session.db';

/**
 * Legacy: where Telegram's connector stores live today. It ignores
 * `XDG_DATA_HOME` (every other store honors it), so with a non-default
 * `XDG_DATA_HOME` the stores sit outside the data root. Kept exactly, because
 * resolving them anywhere else would open empty stores; step 4 moves them.
 */
export function legacyTelegramStoreRoot(env: LayoutEnv = process.env): string {
  return standaloneLinuxDataDir(env) ?? join(layoutHome(env), '.local', 'share', 'openclaw', 'olympus');
}

/**
 * Legacy: the Telegram reader's gateway state, under the XDG state home, where
 * `scripts/telegram-telethon-reader.py` writes it. The service's readiness
 * probe and Delete both read it from here; step 4 moves it.
 */
export function legacyTelegramGatewayStateDir(env: LayoutEnv = process.env): string {
  return env.OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR?.trim()
    || join(env.XDG_STATE_HOME?.trim() || join(layoutHome(env), '.local', 'state'), 'olympus', 'telegram-capture-gateway');
}

// ---------------------------------------------------------------------------
// Account folders (docs/design/source-storage.md, "Layout"; delivery step 4a)
//
// An account's files are either `legacy` (where they have always been: one
// file per store beside the other sources', per-store env overrides honored)
// or `folder` (inside `<data>/sources/<source_id>/<slot>/`). The registry
// says which (core/source-registry.ts), and core/source-placement.ts decides
// it for an account that has no entry yet. These resolvers only turn an
// account into a path; they read no file.

/** Which layout an account's files follow: the registry's `layout`. */
export type LayoutAccountLayout = 'legacy' | 'folder';

/** The account a resolver answers for. */
export interface LayoutAccount {
  source_id: string;
  slot: string;
  layout: LayoutAccountLayout;
}

/** The data root's folder of account folders. */
export const ACCOUNT_FOLDERS_DIR = 'sources';

const FOLDER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A tier name (`secure_local`) or a family and a tier (`chat.secure_local`).
const STORE_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;

function folderSegment(value: string, what: string): string {
  if (!FOLDER_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new TypeError(`An account folder needs a plain ${what}; got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** `<data>/sources/<source_id>/<slot>`: everything one account owns, in the `folder` layout. */
export function accountFolder(account: Pick<LayoutAccount, 'source_id' | 'slot'>, env: LayoutEnv = process.env): string {
  return olympusDataPath(
    env,
    ACCOUNT_FOLDERS_DIR,
    folderSegment(account.source_id, 'source id'),
    folderSegment(account.slot, 'slot'),
  );
}

/** The folder of all account folders: `<data>/sources`. */
export function accountFoldersRoot(env: LayoutEnv = process.env): string {
  return olympusDataPath(env, ACCOUNT_FOLDERS_DIR);
}

/** The data root's folder of deleted accounts' folders, renamed away and awaiting removal. */
export const ACCOUNT_TRASH_DIR = '.trash';

/** `<data>/.trash`: a per-source Delete renames the account's folder here, then empties it. */
export function accountTrashRoot(env: LayoutEnv = process.env): string {
  return olympusDataPath(env, ACCOUNT_TRASH_DIR);
}

/** One entry of `<data>/.trash`: a renamed-away folder, by the plain name it was given or found under. */
export function accountTrashEntry(name: string, env: LayoutEnv = process.env): string {
  return join(accountTrashRoot(env), folderSegment(name, 'trash entry'));
}

/**
 * A path inside an account's folder, `/`-separated and relative to it, as
 * `legacyAccountFiles` names where a moved file goes (`folderPath`).
 */
export function accountFolderEntry(account: Pick<LayoutAccount, 'source_id' | 'slot'>, folderPath: string, env: LayoutEnv = process.env): string {
  const segments = folderPath.split('/');
  for (const segment of segments) folderSegment(segment, 'path segment');
  return join(accountFolder(account, env), ...segments);
}

const TIERS = ['secure_local', 'internal', 'public_safe'] as const;
type LegacyTier = (typeof TIERS)[number];

/**
 * A file that sits beside the others in the data root. A source whose files
 * never sat there (messaging) names the folder they do sit in.
 */
interface LegacyFile {
  file: string;
  dir?: LegacyDir;
}

/** The folder a legacy file sits in: where it is today (a capture path the spawner hands over applied), and by default. */
interface LegacyDir {
  resolved(env: LayoutEnv): string;
  default(env: LayoutEnv): string;
}

const gmailStore = (infix: string): LegacyFile => ({ file: `gmail-${infix}connector-store.sqlite` });
const driveStore = (infix: string): LegacyFile => ({ file: `google-drive-${infix}connector-store.sqlite` });
const dropboxStore = (infix: string): LegacyFile => ({ file: `dropbox-files-${infix}connector-store.sqlite` });
const localFilesStore = (infix: string): LegacyFile => ({ file: `local-files-${infix}connector-store.sqlite` });

/**
 * Where each store of a folder-capable source sits in the `legacy` layout: the
 * names the connectors gave their stores before account folders. No env
 * variable relocates one (owner decision 3, delivery step 6); the boot
 * migration moves them into the account's folder.
 */
const LEGACY_STORES: Readonly<Record<string, Readonly<Record<LegacyTier, LegacyFile | undefined>>>> = {
  'gmail.email': {
    internal: gmailStore(''),
    secure_local: gmailStore('secure-'),
    public_safe: gmailStore('public-'),
  },
  'google_drive.docs': {
    internal: driveStore(''),
    secure_local: driveStore('secure-'),
    public_safe: driveStore('public-'),
  },
  'dropbox.files': {
    secure_local: dropboxStore(''),
    internal: dropboxStore('internal-'),
    public_safe: dropboxStore('public-'),
  },
  'local.files': {
    secure_local: localFilesStore(''),
    internal: localFilesStore('internal-'),
    public_safe: localFilesStore('public-'),
  },
  'readwise.library': {
    internal: { file: 'readwise-connector-store.sqlite' },
    secure_local: { file: 'readwise-secure-connector-store.sqlite' },
    public_safe: undefined,
  },
  'x.bookmarks': {
    internal: { file: 'x-bookmarks-connector-store.sqlite' },
    secure_local: { file: 'x-bookmarks-secure-connector-store.sqlite' },
    public_safe: undefined,
  },
  // Imported archives: one store set per family (`<family>.<tier>`).
  'archive.imports': { secure_local: undefined, internal: undefined, public_safe: undefined },
  // Messaging (step 4b): their stores sit outside the data root, with the capture state.
  'telegram.messages': {
    internal: { file: 'telegram-internal-connector-store.sqlite', dir: telegramStoreDirs() },
    secure_local: { file: 'telegram-protected-connector-store.sqlite', dir: telegramStoreDirs() },
    public_safe: undefined,
  },
  'whatsapp.personal.messages': {
    internal: { file: 'connector-store-internal.db', dir: whatsappStateDirs() },
    secure_local: { file: 'connector-store.db', dir: whatsappStateDirs() },
    public_safe: undefined,
  },
};

const ARCHIVE_IMPORTS = 'archive.imports';
const ARCHIVE_FILE_LABEL: Readonly<Record<string, string>> = { secure_local: '', internal: '-internal', public_safe: '-public' };

/**
 * Sources added after account folders, and their stores' tiers: they never had
 * a legacy place, so every account of one lives in its folder. A new connector
 * declares its tiers here and nothing else about where its files go
 * (docs/CREATE_CONNECTOR.md, Leg 3).
 */
const FOLDER_ONLY_STORES: Record<string, readonly LegacyTier[]> = {};

/** The source ids that have a layout for their files: the rest (Reflect, Roam) are `legacy` for good. */
export const FOLDER_LAYOUT_SOURCES: readonly string[] = [...Object.keys(LEGACY_STORES), ...Object.keys(FOLDER_ONLY_STORES)];

/** Whether a source's accounts can have files at legacy paths: every folder-layout source but one added after account folders. */
export function hasLegacyLayout(sourceId: string): boolean {
  return sourceId in LEGACY_STORES;
}

/** Test seam: declare a folder-only source for the length of `run`, as a new connector would. */
export const __layoutTestHooks = {
  withFolderOnlySource<T>(sourceId: string, tiers: readonly LegacyTier[], run: () => T): T {
    FOLDER_ONLY_STORES[sourceId] = tiers;
    (FOLDER_LAYOUT_SOURCES as string[]).push(sourceId);
    try {
      return run();
    } finally {
      delete FOLDER_ONLY_STORES[sourceId];
      (FOLDER_LAYOUT_SOURCES as string[]).splice((FOLDER_LAYOUT_SOURCES as string[]).indexOf(sourceId), 1);
    }
  },
};

function legacyStoreFile(sourceId: string, name: string): LegacyFile {
  if (sourceId === ARCHIVE_IMPORTS) {
    const [family, tier, extra] = name.split('.');
    if (!family || !tier || extra !== undefined || !(tier in ARCHIVE_FILE_LABEL)) {
      throw new TypeError(`An archive store is named <family>.<tier>; got ${JSON.stringify(name)}.`);
    }
    return { file: `archive-${family}${ARCHIVE_FILE_LABEL[tier]}-connector-store.sqlite` };
  }
  const file = LEGACY_STORES[sourceId]?.[name as LegacyTier];
  if (!file) throw new TypeError(`${sourceId} has no store named ${JSON.stringify(name)}.`);
  return file;
}

/** A legacy file in its folder: the data root, or the capture folder a messaging store sits in. */
function legacyFilePath(env: LayoutEnv, entry: LegacyFile): string {
  return entry.dir ? join(entry.dir.resolved(env), entry.file) : olympusDataPath(env, entry.file);
}

/**
 * The path of one of an account's stores: `stores/<name>.sqlite` in its
 * folder, or, for a `legacy` account, the file its connector has always
 * written (no env variable moves it since step 6). `name` is the tier
 * (`secure_local`, `internal`, `public_safe`), or `<family>.<tier>` for
 * imported archives. The tier sidecars sit beside the store under their usual
 * names (classification/tier-ledger-path.ts).
 */
export function accountStorePath(account: LayoutAccount, name: string, env: LayoutEnv = process.env): string {
  if (!STORE_NAME.test(name)) throw new TypeError(`A store name is a tier or <family>.<tier>; got ${JSON.stringify(name)}.`);
  if (account.layout === 'folder') return join(accountFolder(account, env), 'stores', `${name}.sqlite`);
  if (!hasLegacyLayout(account.source_id)) throw new TypeError(`${account.source_id} has no legacy layout: its stores live in its account folder.`);
  return legacyFilePath(env, legacyStoreFile(account.source_id, name));
}

/**
 * The store of another tier beside a store that sits in an account folder
 * (`.../sources/<source_id>/<slot>/stores/<name>.sqlite`), named as
 * `accountStorePath` names it: the tier is swapped and a family prefix
 * (`<family>.<tier>`) kept. Undefined for a path that is not a store of an
 * account folder. It reads no file and does not look for the data root, so it
 * holds wherever the data folder sits and whatever the store was called
 * before it moved there: a tier set's ledger is found from any of its stores
 * (`classification/tier-set-binding.ts`).
 */
export function accountSiblingStorePath(storeDbPath: string, tier: (typeof TIERS)[number]): string | undefined {
  const file = basename(storeDbPath);
  if (!file.endsWith('.sqlite')) return undefined;
  const name = file.slice(0, -'.sqlite'.length);
  if (!STORE_NAME.test(name)) return undefined;
  const dot = name.lastIndexOf('.');
  const ownTier = name.slice(dot + 1);
  if (!(TIERS as readonly string[]).includes(ownTier)) return undefined;
  const stores = dirname(storeDbPath);
  const slot = dirname(stores);
  const source = dirname(slot);
  if (basename(stores) !== 'stores' || basename(dirname(source)) !== ACCOUNT_FOLDERS_DIR) return undefined;
  if (!FOLDER_SEGMENT.test(basename(slot)) || !FOLDER_SEGMENT.test(basename(source))) return undefined;
  return join(stores, `${name.slice(0, dot + 1)}${tier}.sqlite`);
}

/**
 * The env that relocates a source's files today: only a messaging account's
 * capture paths, which the Gateway-run capture services and a spawner hand
 * over (the per-store `OLYMPUS_*_DB_PATH` overrides are gone since step 6). A
 * `folder` account never honors one.
 */
export function legacyOverrideEnvNames(sourceId: string): string[] {
  return [...messagingRawOverrides(sourceId)];
}

// Raw state kept outside the stores. Each is a file or folder in the account's
// `raw/` folder, named for what it is.
export type AccountRawName =
  | 'watch'
  | 'x-reconcile.sqlite'
  | 'archive-imports.json'
  | 'archive-import-requests.json'
  | 'archive-media-bindings.sqlite'
  | MessagingRawName;

const RAW_OWNER: Readonly<Record<AccountRawName, string>> = {
  watch: 'local.files',
  'x-reconcile.sqlite': 'x.bookmarks',
  'archive-imports.json': ARCHIVE_IMPORTS,
  'archive-import-requests.json': ARCHIVE_IMPORTS,
  'archive-media-bindings.sqlite': ARCHIVE_IMPORTS,
  ...messagingRawOwners(),
};

/**
 * A file the archive record keeps beside it, wherever the record is (its
 * account folder's `raw/`, or the data folder for a `legacy` account): the
 * import requests and the media bindings.
 */
export function archiveStateSiblingPath(statePath: string, name: 'archive-import-requests.json' | 'archive-media-bindings.sqlite' | 'archive-staging'): string {
  return join(dirname(statePath), name);
}

/** X's API usage ledger. It is the quota ledger, kept when a source is deleted, so it is shared and has no account folder. */
export function xBookmarksApiUsageDbPath(env: LayoutEnv = process.env): string {
  return sharedDataPath('x-usage', env);
}

/**
 * The path of a file or folder of an account's raw state: `raw/<name>` in its
 * folder, or, for a `legacy` account, exactly what its resolver returned
 * before folders. `options.usageDbPath` is the X usage ledger a reconcile
 * state accompanies, for a caller that was given one; the reconcile state of
 * a `folder` account follows it only when it is not at its default (a test's
 * or an operator's own ledger), so the shared ledger no longer decides where
 * it lives.
 */
export function accountRawPath(
  account: LayoutAccount,
  name: AccountRawName,
  env: LayoutEnv = process.env,
  options: { usageDbPath?: string } = {},
): string {
  if (RAW_OWNER[name] !== account.source_id) throw new TypeError(`${account.source_id} has no raw state named ${name}.`);
  const messaging = messagingRawPath(account, name, env);
  if (messaging !== undefined) return messaging;
  const usage = options.usageDbPath;
  if (name === 'x-reconcile.sqlite') {
    if (account.layout === 'legacy') {
      if (usage === ':memory:') return ':memory:';
      if (usage?.trim()) return `${usage.trim()}.reconcile`;
      // Beside the API usage store, where the worker keeps it: a caller without a
      // usage path (the CLI's recovery command) must open the same file.
      return `${xBookmarksApiUsageDbPath(env)}.reconcile`;
    }
    if (usage === ':memory:') return ':memory:';
    const relocated = usage?.trim();
    if (relocated && relocated !== xBookmarksApiUsageDbPath(env)) return `${relocated}.reconcile`;
  } else if (account.layout === 'legacy') {
    if (name === 'watch') return olympusDataPath(env, 'local-files-watch');
    // The record, the requests and the media bindings sit in the data root.
    return olympusDataPath(env, name);
  }
  return join(accountFolder(account, env), 'raw', name);
}

/**
 * The names an account of this source can give its stores (`accountStorePath`
 * takes one): a tier, or `<family>.<tier>` for imported archives, whose
 * families the caller lists.
 */
export function accountStoreNames(sourceId: string, archiveFamilies: readonly string[] = []): string[] {
  return sourceId === ARCHIVE_IMPORTS
    ? archiveFamilies.flatMap((family) => TIERS.map((tier) => `${family}.${tier}`))
    : FOLDER_ONLY_STORES[sourceId]
      ? [...FOLDER_ONLY_STORES[sourceId]]
      : Object.entries(LEGACY_STORES[sourceId] ?? {}).flatMap(([tier, file]) => (file ? [tier] : []));
}

/**
 * Stores only the connector-store mount list places, at the `dbPath` the
 * private host's mount list gives them (`config/private-host.env`). No
 * connector resolves them, so a Delete and an export find them here; a
 * lifecycle test fails if a mounted `dbPath` is named by no account. Apple
 * Messages is absent on purpose: no install mounts it and its lane is pinned
 * off (identity air-gap), so it owns no store to lose.
 */
const MOUNTED_STORE_FILES: Readonly<Record<string, readonly string[]>> = {
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  'reflect.notes': ['reflect-notes.sqlite'],
  'roam.notes': ['roam-notes.sqlite'],
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
};

/** The sources whose only stores are the mount list's (Reflect, Roam): `legacy` for good. */
export function mountedStoreSources(): string[] {
  return Object.keys(MOUNTED_STORE_FILES);
}

/** A mount-list source's stores, where the private host's mount list puts them. */
export function mountedStorePaths(sourceId: string, env: LayoutEnv = process.env): string[] {
  return (MOUNTED_STORE_FILES[sourceId] ?? []).map((file) => olympusDataPath(env, file));
}

/**
 * The grandfathered per-family index an install upgraded across the Slice 2
 * cut still holds. Nothing reads it any more, but it sits in the data root,
 * which Delete all removes, so Export copies it and Delete takes it with its
 * account. Each carries its own retired schema marker (never the connector
 * store's).
 */
const PRE_CUTOVER_INDEXES: Readonly<Record<string, { file: string; storeId: string }>> = {
  'gmail.email': { file: 'email-index.sqlite', storeId: 'email-index' },
  'dropbox.files': { file: 'dropbox-files-index.sqlite', storeId: 'dropbox-files-index' },
  'google_drive.docs': { file: 'google-drive-docs-index.sqlite', storeId: 'google-drive-docs-index' },
  'telegram.messages': { file: 'telegram-messages-index.sqlite', storeId: 'telegram-messages-index' },
  'readwise.library': { file: 'readwise-index.sqlite', storeId: 'readwise-index' },
};

/** The pre-1.0 index of this source an upgraded install may still hold, and its schema marker. */
export function preCutoverIndex(sourceId: string, env: LayoutEnv = process.env): { path: string; storeId: string } | undefined {
  const index = PRE_CUTOVER_INDEXES[sourceId];
  return index ? { path: olympusDataPath(env, index.file), storeId: index.storeId } : undefined;
}

/**
 * Legacy: the Telegram spool drain's cursor, in its state folder under the XDG
 * state home, or where `OLYMPUS_TELEGRAM_SPOOL_DRAIN_CURSOR_PATH` or
 * `OLYMPUS_TELEGRAM_SPOOL_DRAIN_STATE_DIR` put it (capture paths, kept).
 */
export function legacyTelegramSpoolDrainCursorPath(env: LayoutEnv = process.env): string {
  return env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_CURSOR_PATH?.trim()
    || join(env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_STATE_DIR?.trim() || join(olympusStateRoot(env), 'telegram-spool-drain'), 'cursor.json');
}

/**
 * Every file or folder a `legacy` account of this source could have at its
 * default locations, no override applied: the evidence that an account
 * already lives in the legacy layout. Tier sidecars and SQLite's `-wal` and
 * `-shm` are not listed; core/source-placement.ts adds them to each store.
 */
export function legacyAccountPaths(
  sourceId: string,
  env: LayoutEnv = process.env,
  archiveFamilies: readonly string[] = [],
): { stores: string[]; raw: string[] } {
  if (!hasLegacyLayout(sourceId)) return { stores: [], raw: [] };
  const names = accountStoreNames(sourceId, archiveFamilies);
  const stores = names.map((name) => {
    const entry = legacyStoreFile(sourceId, name);
    return entry.dir ? join(entry.dir.default(env), entry.file) : olympusDataPath(env, entry.file);
  });
  const raw: string[] = [];
  if (sourceId === 'local.files') raw.push(olympusDataPath(env, 'local-files-watch'));
  if (sourceId === 'x.bookmarks') raw.push(`${olympusDataPath(env, 'x-bookmarks-api-usage.sqlite')}.reconcile`);
  if (sourceId === ARCHIVE_IMPORTS) {
    raw.push(
      olympusDataPath(env, 'archive-imports.json'),
      olympusDataPath(env, 'archive-import-requests.json'),
      olympusDataPath(env, 'archive-media-bindings.sqlite'),
    );
  }
  const messaging = legacyMessagingPaths(sourceId, env);
  return { stores: [...stores, ...messaging.stores], raw: [...raw, ...messaging.raw] };
}

// ---------------------------------------------------------------------------
// Messaging accounts (docs/design/source-storage.md, "Layout"; delivery step 4b)
//
// Telegram and WhatsApp keep more than stores: a capture child writes a
// session, a spool and its own state, and a child never reads the registry.
// The process that spawns it (or, for the Gateway-run services, reads the
// registry read-only) resolves these paths here and hands them over as env.
// In a `folder` account they are all inside the account folder:
//
//   session/telegram.session    Telegram's login, with its -journal beside it
//   raw/telegram-spool          the captured messages
//   raw/telegram-gateway        the reader's state
//   raw/whatsapp                the bridge's state dir: session.db, spool/, media/, the QR files
//
// A `legacy` account resolves each as its caller always did, overrides included.

export const TELEGRAM_SOURCE_ID = 'telegram.messages';
export const WHATSAPP_SOURCE_ID = 'whatsapp.personal.messages';

/**
 * The session lock of a WhatsApp bridge, `bridge.lock` in its state folder: a
 * `flock` its spawner takes and hands to the bridge as an inherited descriptor
 * (core/messaging-capture.ts, core/messaging-pairing.ts), so the bridge holds
 * it for its whole life, after its spawner is gone too. One bridge per
 * session, and the boot migration does not move a session a bridge runs on.
 */
export const WHATSAPP_BRIDGE_LOCK_NAME = 'bridge.lock';
/** The lock the Telegram reader takes in its gateway state folder (`scripts/telegram-telethon-reader.py`, `gateway_process_lock`). */
export const TELEGRAM_GATEWAY_LOCK_NAME = 'gateway.lock';

/** Raw state of a messaging account (`accountRawPath`). */
export type MessagingRawName =
  | 'telegram-spool'
  | 'telegram-gateway'
  | 'whatsapp'
  | 'whatsapp-spool'
  | 'whatsapp-media'
  | 'whatsapp-media-root';

const MESSAGING_RAW_NAMES: readonly string[] = [
  'telegram-spool',
  'telegram-gateway',
  'whatsapp',
  'whatsapp-spool',
  'whatsapp-media',
  'whatsapp-media-root',
];

function messagingRawOwners(): Readonly<Record<MessagingRawName, string>> {
  return {
    'telegram-spool': 'telegram.messages',
    'telegram-gateway': 'telegram.messages',
    whatsapp: 'whatsapp.personal.messages',
    'whatsapp-spool': 'whatsapp.personal.messages',
    'whatsapp-media': 'whatsapp.personal.messages',
    'whatsapp-media-root': 'whatsapp.personal.messages',
  };
}

/** The env that tells the Gateway the native service, not the worker, runs a source's capture. */
export const NATIVE_CAPTURE_OWNER_ENV_NAMES = {
  telegram: 'OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER',
  whatsapp: 'OLYMPUS_NATIVE_WHATSAPP_CAPTURE_OWNER',
} as const;

// What relocates a messaging account's files today. A `folder` account honors none of them.
const TELEGRAM_PATH_OVERRIDES = [
  'OLYMPUS_TELEGRAM_SESSION_PATH',
  'OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR',
  'OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR',
  'OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR',
  'OLYMPUS_TELEGRAM_SPOOL_DRAIN_STATE_DIR',
  'OLYMPUS_TELEGRAM_SPOOL_DRAIN_CURSOR_PATH',
  'OLYMPUS_TELEGRAM_GATEWAY_BACKFILL_REQUESTS_PATH',
] as const;
const WHATSAPP_PATH_OVERRIDES = [
  'OLYMPUS_WHATSAPP_STATE_DIR',
  'OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR',
  'OLYMPUS_WHATSAPP_TRANSCRIBE_STATE_DIR',
  'OLYMPUS_WHATSAPP_TRANSCRIBE_MEDIA_DIR',
] as const;

function messagingRawOverrides(sourceId: string): readonly string[] {
  if (sourceId === TELEGRAM_SOURCE_ID) return TELEGRAM_PATH_OVERRIDES;
  if (sourceId === WHATSAPP_SOURCE_ID) return WHATSAPP_PATH_OVERRIDES;
  return [];
}

/**
 * The native-ownership pin: the env name that says the Gateway-run service
 * owns this source's capture, when it is set. That service reads its paths
 * from plugin config and the files of an account it owns stay where they are
 * (the design's "Gateway-run capture stays legacy"), and the plugin-config
 * capture paths (`worker.telegramCapture.*`, `worker.whatsappCapture.*`)
 * reach only that service, so this one pin covers both. Anything but an
 * explicit off, a value the worker would refuse included, pins.
 */
export function nativeCaptureOwnerPin(sourceId: string, env: LayoutEnv = process.env): string | undefined {
  const name = sourceId === TELEGRAM_SOURCE_ID
    ? NATIVE_CAPTURE_OWNER_ENV_NAMES.telegram
    : sourceId === WHATSAPP_SOURCE_ID ? NATIVE_CAPTURE_OWNER_ENV_NAMES.whatsapp : undefined;
  const value = name ? env[name]?.trim().toLowerCase() : undefined;
  return name && value && !['false', '0', 'no'].includes(value) ? `${name} (native capture)` : undefined;
}

/** `<XDG state home>/olympus`: where the Telegram reader keeps its gateway state by default. */
export function olympusStateRoot(env: LayoutEnv = process.env): string {
  return join(env.XDG_STATE_HOME?.trim() || join(layoutHome(env), '.local', 'state'), 'olympus');
}

function telegramStoreDirs(): LegacyDir {
  return { resolved: legacyTelegramStoreRoot, default: legacyTelegramStoreRoot };
}

// The worker's WhatsApp state directory: OLYMPUS_WHATSAPP_STATE_DIR, else under the capture root.
// (Pairing and Unpair spell an override that names `session.db` as its directory; that is theirs,
// in core/pairing-session-paths.ts, and stays so for a `legacy` account.)
function legacyWhatsAppStateDir(env: LayoutEnv): string {
  return env.OLYMPUS_WHATSAPP_STATE_DIR?.trim() || join(legacyCaptureDataRoot(env), 'whatsapp-live');
}

function whatsappStateDirs(): LegacyDir {
  return { resolved: legacyWhatsAppStateDir, default: (env) => join(legacyCaptureDataRoot(env), 'whatsapp-live') };
}

function isMessagingRawName(name: string): name is MessagingRawName {
  return MESSAGING_RAW_NAMES.includes(name);
}

function messagingRawPath(account: LayoutAccount, name: AccountRawName, env: LayoutEnv): string | undefined {
  if (!isMessagingRawName(name)) return undefined;
  if (account.layout === 'folder') {
    const raw = join(accountFolder(account, env), 'raw');
    if (name === 'telegram-spool' || name === 'telegram-gateway') return join(raw, name);
    if (name === 'whatsapp') return join(raw, 'whatsapp');
    if (name === 'whatsapp-spool') return join(raw, 'whatsapp', 'spool');
    if (name === 'whatsapp-media-root') return join(raw, 'whatsapp', 'media');
    return join(raw, 'whatsapp', 'media', 'audio');
  }
  switch (name) {
    case 'telegram-spool':
      return env.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR?.trim()
        || env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR?.trim()
        || join(legacyCaptureDataRoot(env), 'telegram-capture', 'spool');
    case 'telegram-gateway':
      return legacyTelegramGatewayStateDir(env);
    case 'whatsapp':
      return legacyWhatsAppStateDir(env);
    case 'whatsapp-spool':
      return env.OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR?.trim() || join(legacyWhatsAppStateDir(env), 'spool');
    case 'whatsapp-media':
    case 'whatsapp-media-root': {
      // The transcribe drain reads the captured audio through its own knobs.
      const transcribeStateDir = env.OLYMPUS_WHATSAPP_TRANSCRIBE_STATE_DIR?.trim();
      return env.OLYMPUS_WHATSAPP_TRANSCRIBE_MEDIA_DIR?.trim()
        || join(transcribeStateDir || legacyWhatsAppStateDir(env), 'media', 'audio');
    }
  }
}

/**
 * Telegram's session as a Telethon base path (Telethon adds `.session`, and
 * the pairing receipt names the base): `session/telegram` in the account's
 * folder, else `OLYMPUS_TELEGRAM_SESSION_PATH` (either spelling, trimmed),
 * else the capture root's `telegram/telegram.personal`.
 */
export function accountSessionPath(account: LayoutAccount, env: LayoutEnv = process.env): string {
  if (account.source_id !== TELEGRAM_SOURCE_ID) throw new TypeError(`${account.source_id} has no Telegram session.`);
  if (account.layout === 'folder') return join(accountFolder(account, env), 'session', 'telegram');
  const configured = env.OLYMPUS_TELEGRAM_SESSION_PATH?.trim();
  return configured
    ? (configured.endsWith('.session') ? configured.slice(0, -'.session'.length) : configured)
    : join(legacyCaptureDataRoot(env), 'telegram', 'telegram.personal');
}

/**
 * The path env a `folder` account's capture child is started with, and the
 * only way it learns where its files are. A spawner applies these after every
 * other source of env (the grant's included), so nothing in the process
 * environment can move the child out of the folder.
 */
export function folderCaptureEnv(account: LayoutAccount, env: LayoutEnv = process.env): Record<string, string> {
  if (account.layout !== 'folder') throw new TypeError('Only a folder account has its capture paths set from its folder.');
  if (account.source_id === TELEGRAM_SOURCE_ID) {
    return {
      OLYMPUS_TELEGRAM_SESSION_PATH: accountSessionPath(account, env),
      OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: accountRawPath(account, 'telegram-gateway', env),
      OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: accountRawPath(account, 'telegram-spool', env),
    };
  }
  if (account.source_id === WHATSAPP_SOURCE_ID) return { OLYMPUS_WHATSAPP_STATE_DIR: accountRawPath(account, 'whatsapp', env) };
  throw new TypeError(`${account.source_id} has no capture child.`);
}

/** The env a `folder` account's capture child must not inherit: a path that would send its files out of the folder. */
export function folderCaptureEnvRemoved(account: LayoutAccount): string[] {
  return account.source_id === TELEGRAM_SOURCE_ID
    ? ['OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR', 'OLYMPUS_TELEGRAM_GATEWAY_BACKFILL_REQUESTS_PATH']
    : [];
}

/** The directories a `folder` account's capture child writes into, for a spawner to create privately first. */
export function folderCaptureDirs(account: LayoutAccount, env: LayoutEnv = process.env): string[] {
  if (account.layout !== 'folder') return [];
  if (account.source_id === TELEGRAM_SOURCE_ID) {
    return [
      dirname(accountSessionPath(account, env)),
      accountRawPath(account, 'telegram-gateway', env),
      accountRawPath(account, 'telegram-spool', env),
    ];
  }
  return account.source_id === WHATSAPP_SOURCE_ID ? [accountRawPath(account, 'whatsapp', env)] : [];
}

/**
 * Where a messaging account's capture files could be at their default
 * locations, whichever of the places each capture process picks: the evidence
 * that the account already lives in the legacy layout, beside its stores.
 * (Directories count: a capture folder that exists is a legacy account.)
 */
/**
 * The legacy folder whose presence keeps a messaging account `legacy` (the first
 * of its raw legacy paths, which the placement decision looks at): a pairing that
 * chose the legacy paths makes it first, so no later decision can place the
 * account in a folder while its session is being made there.
 */
export function legacyCaptureClaimDir(sourceId: string, env: LayoutEnv = process.env): string | undefined {
  return legacyMessagingPaths(sourceId, env).raw[0];
}

function legacyMessagingPaths(sourceId: string, env: LayoutEnv): { stores: string[]; raw: string[] } {
  if (sourceId === TELEGRAM_SOURCE_ID) {
    const capture = legacyCaptureDataRoot(env);
    const state = olympusStateRoot(env);
    return {
      stores: [],
      raw: [
        join(capture, 'telegram'),
        join(capture, 'telegram-capture'),
        join(state, 'telegram-capture-gateway'),
        join(state, 'telegram-spool-drain'),
      ],
    };
  }
  if (sourceId === WHATSAPP_SOURCE_ID) {
    // The capture service's default ignores XDG_DATA_HOME, the bridge and the worker honor it.
    return { stores: [], raw: [join(legacyCaptureDataRoot(env), 'whatsapp-live'), legacyWhatsAppServiceStateDir(env)] };
  }
  return { stores: [], raw: [] };
}

// ---------------------------------------------------------------------------
// Moving an existing account into its folder (docs/design/source-storage.md,
// "Migration of existing installs"; delivery steps 4c and 4d)
//
// The boot migration renames an account's files from where they have always
// been to where `accountStorePath` and `accountRawPath` put them. These
// functions are its whole knowledge of the legacy side: the files an account of
// a source owns at the default legacy locations (no override applied; an
// override pins the account and the migration skips it), paired with the name
// the folder layout gives each, and the folders those locations sit in.

/** The sources whose existing accounts the boot migration moves: every one whose accounts can have legacy paths (Telegram and WhatsApp since step 4d). */
export function migratableSources(): readonly string[] {
  return Object.keys(LEGACY_STORES);
}

/** A file or folder an account owns at its legacy location, and what the folder layout calls it. */
export interface LegacyAccountFile {
  /** `store`: a tier store (its tier sidecars follow); `raw`: anything else the account keeps. */
  area: 'store' | 'raw';
  /** The tier (or `<family>.<tier>` for an archive) for a store; for raw state its `AccountRawName`, or a name of its own with `folderPath`. */
  name: string;
  /** Where it sits at the default legacy location, absolute. */
  legacy: string;
  /** Raw state only: a folder, a SQLite database (its `-wal`, `-shm` and `-journal` follow) or a plain file. */
  rawKind?: 'dir' | 'db' | 'file';
  /** Where it goes in the account folder (`/`-separated, relative to it), when `name` is not an `AccountRawName`. */
  folderPath?: string;
}

/** Telegram's login base at its default legacy place (Telethon adds `.session`), as pairing has always put it. */
export function legacyTelegramSessionBase(env: LayoutEnv = process.env): string {
  return join(legacyCaptureDataRoot(env), 'telegram', 'telegram.personal');
}

/** The WhatsApp bridge's state folder at its default legacy place, where pairing, the bridge and the worker put it. */
export function legacyWhatsAppDefaultStateDir(env: LayoutEnv = process.env): string {
  return join(legacyCaptureDataRoot(env), 'whatsapp-live');
}

/**
 * The folders a legacy account's files can sit in, each with the tag the
 * migration's plan writes a path under (`@<tag>/...`), so the registry never
 * names a home folder: the data root (no tag), Telegram's store folder (which
 * ignores `XDG_DATA_HOME`), the capture root (`<XDG data home>/olympus`) and
 * the state root (`<XDG state home>/olympus`). A path is written under the
 * first of these that holds it; on a standalone Linux install the capture root
 * is the data root.
 */
export function migrationPathRoots(env: LayoutEnv = process.env): Array<{ tag: string; root: string }> {
  return [
    { tag: '', root: olympusDataRoot(env) },
    { tag: 'telegram-stores', root: legacyTelegramStoreRoot(env) },
    { tag: 'capture', root: legacyCaptureDataRoot(env) },
    { tag: 'state', root: olympusStateRoot(env) },
  ];
}

/**
 * A login a Telegram pairing made aside and left behind
 * (`<base>.pairing-<pid>-<tag>.session`, core/pairing-session-paths.ts) is named
 * after its login's base, so in the account folder it is named after
 * `session/telegram`: the name it takes there, or undefined for any other name.
 */
export function folderNameOfStagedTelegramLogin(legacyName: string, env: LayoutEnv = process.env): string | undefined {
  const own = basename(legacyTelegramSessionBase(env));
  if (!legacyName.startsWith(own)) return undefined;
  const rest = legacyName.slice(own.length);
  return /^\.pairing-\d{1,10}-[0-9a-f]{8}\.session(?:-journal)?$/.test(rest) ? `telegram${rest}` : undefined;
}

/**
 * Every file or folder an account of a migratable source can own at its default
 * legacy locations, whether or not it exists. Tier sidecars and `-wal`/`-shm`
 * are not listed; the migration adds them to each store. Stores come first: a
 * WhatsApp account's stores sit inside the bridge's state folder and leave it
 * before the folder itself is renamed.
 */
export function legacyAccountFiles(
  sourceId: string,
  env: LayoutEnv = process.env,
  archiveFamilies: readonly string[] = [],
): LegacyAccountFile[] {
  if (!migratableSources().includes(sourceId)) throw new TypeError(`${sourceId} is not moved by the boot migration.`);
  const names = sourceId === ARCHIVE_IMPORTS
    ? archiveFamilies.flatMap((family) => TIERS.map((tier) => `${family}.${tier}`))
    : Object.entries(LEGACY_STORES[sourceId] ?? {}).flatMap(([tier, file]) => (file ? [tier] : []));
  const files: LegacyAccountFile[] = names.map((name) => {
    const entry = legacyStoreFile(sourceId, name);
    return { area: 'store', name, legacy: entry.dir ? join(entry.dir.default(env), entry.file) : olympusDataPath(env, entry.file) };
  });
  if (sourceId === 'local.files') files.push({ area: 'raw', name: 'watch', legacy: olympusDataPath(env, 'local-files-watch'), rawKind: 'dir' });
  if (sourceId === 'x.bookmarks') {
    files.push({ area: 'raw', name: 'x-reconcile.sqlite', legacy: `${olympusDataPath(env, 'x-bookmarks-api-usage.sqlite')}.reconcile`, rawKind: 'db' });
  }
  if (sourceId === ARCHIVE_IMPORTS) {
    files.push(
      { area: 'raw', name: 'archive-imports.json', legacy: olympusDataPath(env, 'archive-imports.json'), rawKind: 'file' },
      { area: 'raw', name: 'archive-import-requests.json', legacy: olympusDataPath(env, 'archive-import-requests.json'), rawKind: 'file' },
    );
  }
  if (sourceId === TELEGRAM_SOURCE_ID) {
    const base = legacyTelegramSessionBase(env);
    const state = olympusStateRoot(env);
    files.push(
      // The login (Telethon's SQLite file) and the pairing lock beside it (a file lease, core/file-lease.ts).
      { area: 'raw', name: 'telegram-session', legacy: `${base}.session`, rawKind: 'db', folderPath: 'session/telegram.session' },
      { area: 'raw', name: 'telegram-pairing-lock', legacy: `${base}.pairing.lock.db`, rawKind: 'db', folderPath: 'session/telegram.pairing.lock.db' },
      { area: 'raw', name: 'telegram-gateway', legacy: join(state, 'telegram-capture-gateway'), rawKind: 'dir' },
      { area: 'raw', name: 'telegram-spool', legacy: join(legacyCaptureDataRoot(env), 'telegram-capture', 'spool'), rawKind: 'dir' },
      // An earlier drain's cursor, read by nothing now: it moves so that a Delete of the folder takes it.
      { area: 'raw', name: 'telegram-spool-drain', legacy: join(state, 'telegram-spool-drain'), rawKind: 'dir', folderPath: 'raw/telegram-spool-drain' },
    );
  }
  if (sourceId === WHATSAPP_SOURCE_ID) {
    files.push({ area: 'raw', name: 'whatsapp', legacy: legacyWhatsAppDefaultStateDir(env), rawKind: 'dir' });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Everything Olympus itself writes
//
// Files on this computer never index Olympus's own folders: its stores, the
// credential references and session secrets beside them, and the capture
// services' state. `olympusOwnRoots` is the one list of them. It follows each
// writer's own resolution, so a root is where the writer puts it under the
// environment (XDG homes, the Linux install receipt) in effect, and the
// folders that writers fix under the home are named here too, for an install
// whose environment has changed since.

/** `OLYMPUS_MEDIA_CACHE_DIR`: a folder the owner names to hold prepared photo copies. */
export const MEDIA_CACHE_DIR_ENV = 'OLYMPUS_MEDIA_CACHE_DIR';

/**
 * Where prepared photo copies are kept: `<data root>/media-cache`, or a
 * dedicated `olympus-media` subdirectory of `OLYMPUS_MEDIA_CACHE_DIR`.
 * `mediaCacheDir` (core/media-cache.ts) adds its checks to this answer.
 */
export function mediaCacheRoot(env: LayoutEnv = process.env): string {
  const configured = env[MEDIA_CACHE_DIR_ENV]?.trim();
  return configured ? join(configured, 'olympus-media') : olympusDataPath(env, 'media-cache');
}

/**
 * Where a `legacy` account's file readers' input is written when the source
 * has to write it (a member of an archive, a part of a message):
 * `<data root>/extraction-spool`, shared by every legacy account and keyed
 * inside by corpus and account scope. A `folder` account keeps its own in its
 * folder (`accountExtractionSpoolRoot`). Private to the extraction runner,
 * which removes each file after reading and sweeps leftovers of a crash at
 * start.
 */
export function extractionSpoolRoot(env: LayoutEnv = process.env): string {
  return olympusDataPath(env, 'extraction-spool');
}

/**
 * Where an account's file readers' input is written: `raw/extraction-spool` in
 * its folder, so the raw bytes of a recording or an attachment sit with the
 * account that owns them and a Delete of the account takes them with the
 * folder. A `legacy` account has no folder, so it uses the shared
 * `extractionSpoolRoot`. Inside, scratch files are keyed by corpus and account
 * scope (file-extraction/spool.ts), because one account holds several corpora
 * and, for imported archives, many account scopes.
 */
export function accountExtractionSpoolRoot(account: LayoutAccount, env: LayoutEnv = process.env): string {
  return account.layout === 'folder'
    ? join(accountFolder(account, env), 'raw', 'extraction-spool')
    : extractionSpoolRoot(env);
}

/** A WhatsApp state location as a folder: the value names the folder, or the `session.db` inside it. */
export function whatsappStateDirFromValue(value: string): string {
  const trimmed = value.trim();
  return basename(trimmed) === WHATSAPP_SESSION_FILE ? dirname(trimmed) : trimmed;
}

/**
 * The Linux install's own folders: where the receipt (else the environment)
 * puts the config, data, state, cache, package and runtime folders. A receipt
 * outranks a shell whose XDG homes have since changed. Nothing off Linux, and
 * nothing when the layout cannot be read: the environment's roots still apply.
 */
function linuxInstallRoots(env: LayoutEnv): string[] {
  if (process.platform !== 'linux') return [];
  try {
    const layout = resolveLinuxEngineLayout(env);
    return [
      layout.configDir,
      layout.dataDir,
      layout.packageDir,
      join(layout.dataHome, 'olympus'),
      dirname(layout.stateDir),
      dirname(layout.cacheDir),
      ...(layout.runtimeDir ? [layout.runtimeDir] : []),
    ];
  } catch {
    return [];
  }
}

/**
 * What an install's plugin config says about where the capture services keep
 * their state (`worker.telegramCapture.stateDir` / `spoolDir`,
 * `worker.whatsappCapture.stateDir`). The config module hands it over
 * (`configuredCaptureLocations`); this module reads no config itself.
 */
export interface OlympusCaptureConfig {
  telegramStateDir?: string;
  telegramSpoolDir?: string;
  whatsappStateDir?: string;
}

/**
 * Folders an install shares with other things, and so never Olympus's own as a
 * whole: the home, the XDG homes and the base folders under them, the Mac's
 * Library folders. Anything above one of them is shared too.
 */
export function olympusSharedBases(env: LayoutEnv = process.env): string[] {
  const home = layoutHome(env);
  const bases = [
    home,
    join(home, '.local'),
    join(home, '.local', 'share'),
    join(home, '.local', 'state'),
    join(home, '.config'),
    join(home, '.cache'),
    join(home, 'Library'),
    join(home, 'Library', 'Application Support'),
    join(home, 'Library', 'Logs'),
  ];
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('XDG_') && value?.trim()) bases.push(value.trim());
  }
  return bases.filter((path) => isAbsolute(path)).map((path) => resolve(path));
}

/**
 * Whether a folder can be Olympus's whole: it is not one of `sharedBases`, nor
 * a folder above one. Compared as spelled, and without regard to case on a Mac.
 * Where a link really leads needs the file system, so this module does not
 * look: a caller that resolves links asks again with the real destination and
 * the real spellings of the bases.
 */
export function isDedicatedFolder(path: string, sharedBases: readonly string[]): boolean {
  const fold = (value: string): string => process.platform === 'darwin' ? value.toLowerCase() : value;
  const folder = fold(resolve(path));
  if (folder === '/') return false;
  return !sharedBases.some((base) => {
    const shared = fold(resolve(base));
    return shared === folder || shared.startsWith(`${folder}/`);
  });
}

/** `isDedicatedFolder` against this environment's `olympusSharedBases`. */
export function isDedicatedOlympusFolder(path: string, env: LayoutEnv = process.env): boolean {
  return isDedicatedFolder(path, olympusSharedBases(env));
}

/** Where Olympus itself writes: folders that are wholly its own, and where the capture services were moved to. */
export interface OlympusOwnLocations {
  /** Where the install and its defaults put things, whatever the environment says about the capture services. */
  fixed: string[];
  /**
   * Where an environment variable or the plugin config moved a capture
   * service's folder to, each one dedicated as spelled. A caller that resolves
   * links checks where it really leads before treating it as Olympus's whole.
   */
  moved: string[];
}

/**
 * Every place Olympus itself writes to, as absolute paths in the spelling its
 * writers use (a caller that compares against real paths resolves links
 * itself). Relative locations a writer would accept are left out: they name no
 * fixed place.
 *
 *  - data: the data root, the media cache, and the legacy roots above (the
 *    capture services' state, Telegram's stores and gateway state);
 *  - config: `worker.env`, the dashboard session secret, the secret store and
 *    `handles.json`. `handles.json` and the secret store sit under
 *    `<home>/.config/olympus` whatever `XDG_CONFIG_HOME` says; the Linux
 *    install keeps its own under `$XDG_CONFIG_HOME/olympus`;
 *  - state: the lifecycle, credential-health and drain-guard state under
 *    `<home>/.local/state/olympus`, and the Telegram reader's under
 *    `$XDG_STATE_HOME/olympus`;
 *  - cache: the WhatsApp bridge and the Telegram Python under
 *    `$XDG_CACHE_HOME/olympus` (`<home>/.cache/olympus` by default);
 *  - the Mac's app folder and logs under `~/Library`;
 *  - the Linux install's folders (`linuxInstallRoots`);
 *  - `moved`: the capture services' state and spool folders when an
 *    environment variable or the plugin config (`capture`) moves them, and only
 *    a dedicated folder (`isDedicatedOlympusFolder`). One that names the home
 *    folder, a shared base or a folder above one is Olympus's in part only,
 *    and Olympus protects no part of it (docs/design/local-files.md, "Known limits").
 */
export function olympusOwnLocations(env: LayoutEnv = process.env, capture: OlympusCaptureConfig = {}): OlympusOwnLocations {
  const home = layoutHome(env);
  const xdg = (name: string, fallback: string): string => env[name]?.trim() || join(home, fallback);
  const fixed: string[] = [
    olympusDataRoot(env),
    mediaCacheRoot(env),
    legacyCaptureDataRoot(env),
    legacyWhatsAppServiceStateDir(env),
    legacyTelegramStoreRoot(env),
    join(xdg('XDG_STATE_HOME', '.local/state'), 'olympus', 'telegram-capture-gateway'),
    join(home, '.olympus'),
    join(home, '.config', 'olympus'),
    join(home, '.local', 'share', 'olympus'),
    join(home, '.local', 'share', 'openclaw', 'olympus'),
    join(home, '.local', 'state', 'olympus'),
    join(home, '.cache', 'olympus'),
    join(home, 'Library', 'Logs', 'Olympus'),
    join(home, 'Library', 'Application Support', 'Olympus'),
    join(xdg('XDG_CONFIG_HOME', '.config'), 'olympus'),
    join(xdg('XDG_STATE_HOME', '.local/state'), 'olympus'),
    join(xdg('XDG_CACHE_HOME', '.cache'), 'olympus'),
    ...linuxInstallRoots(env),
  ];
  const moved: string[] = [];
  const place = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (!trimmed || !isAbsolute(trimmed)) return;
    const dir = resolve(trimmed);
    if (isDedicatedOlympusFolder(dir, env)) moved.push(dir);
  };
  const whatsappState = env.OLYMPUS_WHATSAPP_STATE_DIR?.trim();
  if (whatsappState) place(whatsappStateDirFromValue(whatsappState));
  place(capture.whatsappStateDir);
  place(env.OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR);
  place(env.OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR);
  place(capture.telegramStateDir);
  // The reader writes to the first of these that is set (the plugin config
  // outranks the environment for it); the worker reads the other two. Each is a
  // place the spool may be.
  place(env.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR);
  place(env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR);
  place(capture.telegramSpoolDir);
  const clean = (paths: string[]): string[] => [...new Set(paths.filter((path) => isAbsolute(path)).map((path) => resolve(path)))];
  return { fixed: clean(fixed), moved: clean(moved) };
}

/** Every folder of `olympusOwnLocations`, as spelled: all of them wholly Olympus's. */
export function olympusOwnRoots(env: LayoutEnv = process.env, capture: OlympusCaptureConfig = {}): string[] {
  const own = olympusOwnLocations(env, capture);
  return [...new Set([...own.fixed, ...own.moved])];
}

// ---------------------------------------------------------------------------
// Uninstall (docs/design/source-storage.md, "Export and uninstall"; step 5)

/**
 * The folders an uninstall deals with, the one list of them: what the macOS
 * uninstaller names as kept (site/uninstall.sh keeps data and says where it
 * is) and what the standalone Linux `--purge` removes (site/uninstall-linux.sh),
 * beside the machinery each tracks itself. Every root Olympus writes data,
 * settings, state or caches under is here, the legacy capture root and the
 * Telegram reader's state among them, so nothing is left that neither names.
 * The scripts run no Olympus code, so each spells the list in its own words;
 * test/uninstall-roots.test.ts holds both to this one.
 *
 * Linux removes only the install's own folders, which its receipt proves it
 * made: config, data, package, state and cache. A folder outside them (the
 * legacy capture root `<data home>/olympus`, the Telegram reader's state in
 * `<state home>/olympus`) may be an OpenClaw-hosted install's on the same
 * account, so the purge never infers it is its own; a legacy messaging
 * account's files there move into the data folder with its migration
 * (delivery step 4d), and a folder account's are there already.
 */
export function olympusUninstallRoots(env: LayoutEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = layoutHome(env);
  if (platform === 'linux') {
    const layout = resolveLinuxEngineLayout(env);
    return [...new Set([layout.configDir, layout.dataDir, layout.packageDir, layout.stateDir, layout.cacheDir])];
  }
  return [...new Set([
    join(home, '.olympus'),
    join(home, '.config', 'olympus'),
    olympusDataRoot(env),
    // Telegram's legacy stores ignore XDG_DATA_HOME, and so does the WhatsApp capture service's state.
    legacyTelegramStoreRoot(env),
    legacyCaptureDataRoot(env),
    dirname(legacyWhatsAppServiceStateDir(env)),
    olympusStateRoot(env),
    join(home, '.local', 'state', 'olympus'),
    join(env.XDG_CACHE_HOME?.trim() || join(home, '.cache'), 'olympus'),
    join(home, '.cache', 'olympus'),
    join(home, 'Library', 'Logs', 'Olympus'),
  ])];
}
