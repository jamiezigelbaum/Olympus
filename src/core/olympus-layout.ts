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

/** A path under the data root. */
export function olympusDataPath(env: LayoutEnv, ...segments: string[]): string {
  return join(olympusDataRoot(env), ...segments);
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

const TIERS = ['secure_local', 'internal', 'public_safe'] as const;
type LegacyTier = (typeof TIERS)[number];

/** A file that sits beside the others in the data root, and the env override that moves it. */
interface LegacyFile {
  file: string;
  override?: string;
}

const gmailStore = (infix: string, overrideInfix: string): LegacyFile => ({
  file: `gmail-${infix}connector-store.sqlite`,
  override: `OLYMPUS_SOURCE_INDEX_GMAIL_${overrideInfix}CONNECTOR_STORE_DB_PATH`,
});
const driveStore = (infix: string, overrideInfix: string): LegacyFile => ({
  file: `google-drive-${infix}connector-store.sqlite`,
  override: `OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_${overrideInfix}CONNECTOR_STORE_DB_PATH`,
});
const dropboxStore = (infix: string, overrideInfix: string): LegacyFile => ({
  file: `dropbox-files-${infix}connector-store.sqlite`,
  override: `OLYMPUS_SOURCE_INDEX_DROPBOX_${overrideInfix}CONNECTOR_STORE_DB_PATH`,
});
const localFilesStore = (infix: string, overrideInfix: string): LegacyFile => ({
  file: `local-files-${infix}connector-store.sqlite`,
  override: `OLYMPUS_SOURCE_INDEX_LOCAL_FILES_${overrideInfix}CONNECTOR_STORE_DB_PATH`,
});

/**
 * Where each store of a folder-capable source sits in the `legacy` layout, and
 * the override that relocates it. Moved word for word from the connectors'
 * `default*DbPath` functions, which now ask here; delivery step 6 deletes the
 * overrides with the rest of this table.
 */
const LEGACY_STORES: Readonly<Record<string, Readonly<Record<LegacyTier, LegacyFile | undefined>>>> = {
  'gmail.email': {
    internal: gmailStore('', ''),
    secure_local: gmailStore('secure-', 'SECURE_'),
    public_safe: gmailStore('public-', 'PUBLIC_'),
  },
  'google_drive.docs': {
    internal: driveStore('', ''),
    secure_local: driveStore('secure-', 'SECURE_'),
    public_safe: driveStore('public-', 'PUBLIC_'),
  },
  'dropbox.files': {
    secure_local: dropboxStore('', ''),
    internal: dropboxStore('internal-', 'INTERNAL_'),
    public_safe: dropboxStore('public-', 'PUBLIC_'),
  },
  'local.files': {
    secure_local: localFilesStore('', ''),
    internal: localFilesStore('internal-', 'INTERNAL_'),
    public_safe: localFilesStore('public-', 'PUBLIC_'),
  },
  'readwise.library': {
    internal: {
      file: 'readwise-connector-store.sqlite',
      override: 'OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_DB_PATH',
    },
    secure_local: {
      file: 'readwise-secure-connector-store.sqlite',
      override: 'OLYMPUS_SOURCE_INDEX_READWISE_SECURE_CONNECTOR_STORE_DB_PATH',
    },
    public_safe: undefined,
  },
  'x.bookmarks': {
    internal: {
      file: 'x-bookmarks-connector-store.sqlite',
      override: 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_DB_PATH',
    },
    secure_local: {
      file: 'x-bookmarks-secure-connector-store.sqlite',
      override: 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_SECURE_CONNECTOR_STORE_DB_PATH',
    },
    public_safe: undefined,
  },
  // Imported archives: one store set per family (`<family>.<tier>`), no override.
  'archive.imports': { secure_local: undefined, internal: undefined, public_safe: undefined },
};

const ARCHIVE_IMPORTS = 'archive.imports';
const ARCHIVE_FILE_LABEL: Readonly<Record<string, string>> = { secure_local: '', internal: '-internal', public_safe: '-public' };

/** The source ids that have a layout for their files: the rest are `legacy` for good (until a later step). */
export const FOLDER_LAYOUT_SOURCES: readonly string[] = Object.keys(LEGACY_STORES);

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

/** `override.trim()` when set, else a file in the data root: the one rule every legacy resolver followed. */
function legacyFilePath(env: LayoutEnv, entry: LegacyFile): string {
  const configured = entry.override ? env[entry.override]?.trim() : undefined;
  return configured || olympusDataPath(env, entry.file);
}

/**
 * The path of one of an account's stores: `stores/<name>.sqlite` in its
 * folder, or, for a `legacy` account, exactly what the connector's resolver
 * returned before folders, its env override included. `name` is the tier
 * (`secure_local`, `internal`, `public_safe`), or `<family>.<tier>` for
 * imported archives. The tier sidecars sit beside the store under their usual
 * names (classification/tier-ledger-path.ts).
 */
export function accountStorePath(account: LayoutAccount, name: string, env: LayoutEnv = process.env): string {
  if (!STORE_NAME.test(name)) throw new TypeError(`A store name is a tier or <family>.<tier>; got ${JSON.stringify(name)}.`);
  if (account.layout === 'folder') return join(accountFolder(account, env), 'stores', `${name}.sqlite`);
  return legacyFilePath(env, legacyStoreFile(account.source_id, name));
}

/** The env overrides that relocate a source's files today. A `folder` account never honors one. */
export function legacyOverrideEnvNames(sourceId: string): string[] {
  const names = Object.values(LEGACY_STORES[sourceId] ?? {}).flatMap((file) => (file?.override ? [file.override] : []));
  return [...names, ...(LEGACY_RAW_OVERRIDES[sourceId] ?? [])];
}

/** The env override of one store's legacy path (the connectors export it as a constant). */
export function legacyStoreOverrideEnv(sourceId: string, name: string): string {
  const override = legacyStoreFile(sourceId, name).override;
  if (!override) throw new TypeError(`${sourceId} ${name} has no path override.`);
  return override;
}

// Raw state kept outside the stores. Each is a file or folder in the account's
// `raw/` folder, named for what it is.
export type AccountRawName =
  | 'watch'
  | 'x-reconcile.sqlite'
  | 'archive-imports.json'
  | 'archive-import-requests.json';

const RAW_OWNER: Readonly<Record<AccountRawName, string>> = {
  watch: 'local.files',
  'x-reconcile.sqlite': 'x.bookmarks',
  'archive-imports.json': ARCHIVE_IMPORTS,
  'archive-import-requests.json': ARCHIVE_IMPORTS,
};

const ARCHIVE_STATE_OVERRIDE = 'OLYMPUS_ARCHIVE_IMPORTS_STATE_PATH';
const X_USAGE_OVERRIDE = 'OLYMPUS_SOURCE_INDEX_X_API_USAGE_DB_PATH';
const X_RECONCILE_OVERRIDE = 'OLYMPUS_SOURCE_INDEX_X_RECONCILE_STATE_DB_PATH';
const LEGACY_RAW_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  // The reconcile state sits beside the usage ledger today, so relocating
  // either one relocates it.
  'x.bookmarks': [X_USAGE_OVERRIDE, X_RECONCILE_OVERRIDE],
  [ARCHIVE_IMPORTS]: [ARCHIVE_STATE_OVERRIDE],
};

/** X's API usage ledger. It is the quota ledger, kept when a source is deleted, so it is shared and has no account folder. */
export function xBookmarksApiUsageDbPath(env: LayoutEnv = process.env): string {
  return env[X_USAGE_OVERRIDE]?.trim() || olympusDataPath(env, 'x-bookmarks-api-usage.sqlite');
}

function legacyArchiveStatePath(env: LayoutEnv): string {
  return env[ARCHIVE_STATE_OVERRIDE]?.trim() || olympusDataPath(env, 'archive-imports.json');
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
  const usage = options.usageDbPath;
  if (name === 'x-reconcile.sqlite') {
    if (account.layout === 'legacy') {
      const configured = env[X_RECONCILE_OVERRIDE]?.trim();
      if (configured) return configured;
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
    const state = legacyArchiveStatePath(env);
    // The requests sit beside the state, wherever it is.
    return name === 'archive-imports.json' ? state : join(dirname(state), 'archive-import-requests.json');
  }
  return join(accountFolder(account, env), 'raw', name);
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
  const names = sourceId === ARCHIVE_IMPORTS
    ? archiveFamilies.flatMap((family) => TIERS.map((tier) => `${family}.${tier}`))
    : Object.entries(LEGACY_STORES[sourceId] ?? {}).flatMap(([tier, file]) => (file ? [tier] : []));
  const stores = names.map((name) => olympusDataPath(env, legacyStoreFile(sourceId, name).file));
  const raw: string[] = [];
  if (sourceId === 'local.files') raw.push(olympusDataPath(env, 'local-files-watch'));
  if (sourceId === 'x.bookmarks') raw.push(`${olympusDataPath(env, 'x-bookmarks-api-usage.sqlite')}.reconcile`);
  if (sourceId === ARCHIVE_IMPORTS) raw.push(olympusDataPath(env, 'archive-imports.json'), olympusDataPath(env, 'archive-import-requests.json'));
  return { stores, raw };
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

/** A WhatsApp state location as a folder: the value names the folder, or the `session.db` inside it. */
export function whatsappStateDirFromValue(value: string): string {
  const trimmed = value.trim();
  return basename(trimmed) === 'session.db' ? dirname(trimmed) : trimmed;
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
 * Every folder Olympus itself writes to, as absolute paths in the spelling its
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
 *  - the Linux install's folders (`linuxInstallRoots`).
 */
export function olympusOwnRoots(env: LayoutEnv = process.env): string[] {
  const home = layoutHome(env);
  const xdg = (name: string, fallback: string): string => env[name]?.trim() || join(home, fallback);
  const whatsappState = env.OLYMPUS_WHATSAPP_STATE_DIR?.trim();
  const candidates = [
    olympusDataRoot(env),
    mediaCacheRoot(env),
    legacyCaptureDataRoot(env),
    legacyWhatsAppServiceStateDir(env),
    legacyTelegramStoreRoot(env),
    legacyTelegramGatewayStateDir(env),
    ...(whatsappState ? [whatsappStateDirFromValue(whatsappState)] : []),
    join(home, '.olympus'),
    join(home, '.config', 'olympus'),
    join(home, '.local', 'share', 'olympus'),
    join(home, '.local', 'share', 'openclaw', 'olympus'),
    join(home, '.local', 'state', 'olympus'),
    join(home, '.cache', 'olympus'),
    join(xdg('XDG_CONFIG_HOME', '.config'), 'olympus'),
    join(xdg('XDG_STATE_HOME', '.local/state'), 'olympus'),
    join(xdg('XDG_CACHE_HOME', '.cache'), 'olympus'),
    ...linuxInstallRoots(env),
  ];
  return [...new Set(candidates.filter((path) => isAbsolute(path)).map((path) => resolve(path)))];
}
