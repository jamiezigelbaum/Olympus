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
 * Legacy: the state folder scripts/whatsapp-live-sync.ts has always used (a cron
 * job's, not the worker's): `OLYMPUS_WHATSAPP_STATE_DIR` or `<home>/.local/share/olympus/whatsapp-live`.
 * It reads no other variable (`XDG_DATA_HOME` and every spool or store override
 * included), so an install that relocates the data folder does not move it.
 * Kept exactly, with the home as the OS reports it, not `env.HOME`.
 */
export function legacyWhatsAppLiveSyncStateDir(env: LayoutEnv = process.env, homeDir: string = homedir()): string {
  return env.OLYMPUS_WHATSAPP_STATE_DIR?.trim() || join(homeDir, '.local', 'share', 'olympus', 'whatsapp-live');
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

/** The data root's folder of deleted accounts' folders, renamed away and awaiting removal. */
export const ACCOUNT_TRASH_DIR = '.trash';

/** `<data>/.trash`: a per-source Delete renames the account's folder here, then empties it. */
export function accountTrashRoot(env: LayoutEnv = process.env): string {
  return olympusDataPath(env, ACCOUNT_TRASH_DIR);
}

const TIERS = ['secure_local', 'internal', 'public_safe'] as const;
type LegacyTier = (typeof TIERS)[number];

/**
 * A file that sits beside the others in the data root, and the env override
 * that moves it. A source whose files never sat there (messaging) names the
 * folder they do sit in, and every override of the file in the order the
 * connector tried them.
 */
interface LegacyFile {
  file: string;
  override?: string | readonly string[];
  dir?: LegacyDir;
}

/** The folder a legacy file sits in: where it is today (env override applied), and by default. */
interface LegacyDir {
  resolved(env: LayoutEnv): string;
  default(env: LayoutEnv): string;
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
  // Messaging (step 4b): their stores sit outside the data root, with the capture state.
  'telegram.messages': {
    internal: { file: 'telegram-internal-connector-store.sqlite', dir: telegramStoreDirs() },
    secure_local: { file: 'telegram-protected-connector-store.sqlite', dir: telegramStoreDirs() },
    public_safe: undefined,
  },
  'whatsapp.personal.messages': {
    internal: {
      file: 'connector-store-internal.db',
      override: 'OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH',
      dir: whatsappStateDirs(),
    },
    secure_local: {
      file: 'connector-store.db',
      override: [
        'OLYMPUS_SOURCE_INDEX_WHATSAPP_CONNECTOR_STORE_DB_PATH',
        'OLYMPUS_WHATSAPP_CONNECTOR_STORE_DB_PATH',
        'OLYMPUS_WHATSAPP_LIVE_DRAIN_DB_PATH',
      ],
      dir: whatsappStateDirs(),
    },
    public_safe: undefined,
  },
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

const overrideNamesOf = (entry: LegacyFile | undefined): readonly string[] =>
  entry?.override === undefined ? [] : typeof entry.override === 'string' ? [entry.override] : entry.override;

/** The first override that is set, trimmed, else a file in its folder (the data root): the one rule every legacy resolver followed. */
function legacyFilePath(env: LayoutEnv, entry: LegacyFile): string {
  for (const name of overrideNamesOf(entry)) {
    const configured = env[name]?.trim();
    if (configured) return configured;
  }
  return entry.dir ? join(entry.dir.resolved(env), entry.file) : olympusDataPath(env, entry.file);
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

/** The env overrides that relocate a source's files today. A `folder` account never honors one. */
export function legacyOverrideEnvNames(sourceId: string): string[] {
  const names = Object.values(LEGACY_STORES[sourceId] ?? {}).flatMap((file) => overrideNamesOf(file));
  return [...names, ...(LEGACY_RAW_OVERRIDES[sourceId] ?? []), ...messagingRawOverrides(sourceId)];
}

/** The env override of one store's legacy path (the connectors export it as a constant). */
export function legacyStoreOverrideEnv(sourceId: string, name: string): string {
  const [override] = overrideNamesOf(legacyStoreFile(sourceId, name));
  if (!override) throw new TypeError(`${sourceId} ${name} has no path override.`);
  return override;
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
  const messaging = messagingRawPath(account, name, env);
  if (messaging !== undefined) return messaging;
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
    // The requests and the media bindings sit beside the state, wherever it is.
    return name === 'archive-imports.json' ? state : join(dirname(state), name);
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
    : Object.entries(LEGACY_STORES[sourceId] ?? {}).flatMap(([tier, file]) => (file ? [tier] : []));
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
// "Migration of existing installs"; delivery step 4c)
//
// The boot migration renames an account's files from where they have always
// been to where `accountStorePath` and `accountRawPath` put them. These two
// functions are its whole knowledge of the legacy side: the files an account of
// a source owns at the default legacy locations (no override applied; an
// override pins the account and the migration skips it), paired with the name
// the folder layout gives each.

/** The sources whose existing accounts the boot migration moves: every one with a folder layout but the messaging sources (step 4d). */
export function migratableSources(): readonly string[] {
  return FOLDER_LAYOUT_SOURCES.filter((sourceId) => sourceId !== TELEGRAM_SOURCE_ID && sourceId !== WHATSAPP_SOURCE_ID);
}

/** A file or folder an account owns at its legacy location, and what the folder layout calls it. */
export interface LegacyAccountFile {
  /** `store`: a tier store (its tier sidecars follow); `raw`: raw state kept outside the stores. */
  area: 'store' | 'raw';
  /** The tier (or `<family>.<tier>` for an archive) for a store, the `AccountRawName` for raw state. */
  name: string;
  /** Where it sits at the default legacy location, absolute. */
  legacy: string;
  /** Raw state only: a folder, a SQLite database (its `-wal` and `-shm` follow) or a plain file. */
  rawKind?: 'dir' | 'db' | 'file';
}

/**
 * Every file or folder an account of a migratable source can own at its default
 * legacy locations, whether or not it exists. Tier sidecars and `-wal`/`-shm`
 * are not listed; the migration adds them to each store.
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
  const files: LegacyAccountFile[] = names.map((name) => ({
    area: 'store',
    name,
    legacy: olympusDataPath(env, legacyStoreFile(sourceId, name).file),
  }));
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
