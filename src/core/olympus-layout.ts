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
import { dirname, join } from 'node:path';
import { standaloneLinuxDataDir } from './linux-engine-layout.ts';

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
  | MessagingRawName;

const RAW_OWNER: Readonly<Record<AccountRawName, string>> = {
  watch: 'local.files',
  'x-reconcile.sqlite': 'x.bookmarks',
  'archive-imports.json': ARCHIVE_IMPORTS,
  'archive-import-requests.json': ARCHIVE_IMPORTS,
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
  const stores = names.map((name) => {
    const entry = legacyStoreFile(sourceId, name);
    return entry.dir ? join(entry.dir.default(env), entry.file) : olympusDataPath(env, entry.file);
  });
  const raw: string[] = [];
  if (sourceId === 'local.files') raw.push(olympusDataPath(env, 'local-files-watch'));
  if (sourceId === 'x.bookmarks') raw.push(`${olympusDataPath(env, 'x-bookmarks-api-usage.sqlite')}.reconcile`);
  if (sourceId === ARCHIVE_IMPORTS) raw.push(olympusDataPath(env, 'archive-imports.json'), olympusDataPath(env, 'archive-import-requests.json'));
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
