/**
 * What an account owns on disk, for Export, Delete and Delete all
 * (docs/design/source-storage.md, "Delete" and "Export and uninstall";
 * delivery step 5).
 *
 * The data lifecycle (`data-lifecycle.ts`) knows no source by name: it takes
 * the accounts from the registry and asks here what each one has. An account
 * in the `folder` layout owns its folder, and its stores are named here only
 * so their picture holds and tier ledgers can be read before the folder goes.
 * An account still in the `legacy` layout (until delivery steps 4d and 6 have
 * moved or retired every one) owns the files the layout module's legacy
 * resolvers name (core/olympus-layout.ts, through core/source-placement.ts),
 * which are exactly the paths its connector reads and writes, overrides
 * included; and the pairing module names its session (core/pairing-session-paths.ts).
 *
 * Kept here, not in the layout module, are only what no connector resolves any
 * more: the pre-1.0 per-family indexes an upgraded install still has on disk,
 * and the stores the connector-store mount list places (Reflect, Roam).
 */
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  FOLDER_LAYOUT_SOURCES,
  TELEGRAM_SOURCE_ID,
  WHATSAPP_SOURCE_ID,
  accountFolder,
  accountRawPath,
  accountStoreNames,
  accountStorePath,
  olympusDataPath,
  xBookmarksApiUsageDbPath,
  type AccountRawName,
  type LayoutAccount,
  type LayoutEnv,
} from './olympus-layout.ts';
import { archiveImportFamilies } from './archive-formats.ts';
import { placedAccount } from './source-placement.ts';
import { DEFAULT_ACCOUNT_SLOT } from './source-registry.ts';
import { defaultDropboxIngestionPolicyPath } from './source-ingestion-policy.ts';
import { captureGrantPathBeside, captureGrantSessionEvidence, type CaptureGrantSessionEvidence } from './messaging-capture-grant-file.ts';
import { telegramPairingSessionPaths, whatsappPairingSessionPaths, whatsappStateDir } from './pairing-session-paths.ts';
import type { SourceCorpusConfig } from './source-corpus-registry.ts';
import { archiveImportCorpora } from '../workers/archive-import/store.ts';
import { ARCHIVE_MEDIA_BINDINGS_STORE_ID } from '../workers/archive-import/media-bindings.ts';
import { X_BOOKMARKS_RECONCILE_STATE_STORE_ID } from '../workers/x-bookmarks/reconcile-state.ts';

/** The account the files are asked for: its source, slot and layout. */
export type AccountFilesAccount = LayoutAccount;

/** A SQLite database an account keeps outside its stores, and the schema marker it carries. */
export interface AccountDatabase {
  path: string;
  storeId: string;
}

export interface AccountFiles {
  account: AccountFilesAccount;
  /** The account's folder: its whole footprint when the layout is `folder` (a legacy account's left on disk counts too). */
  folder?: string;
  /** Its connector stores; each one's tier sidecars and `-wal`/`-shm` sit beside it. */
  stores: string[];
  /** A pre-1.0 per-family index an upgraded install still holds: exported, and deleted with the account. */
  preCutoverIndex?: AccountDatabase;
  /**
   * Raw state (spools, watch snapshots, capture state): deleted, never exported.
   * A folder account's is inside its folder, named so a Delete and an export can say so.
   */
  raw: string[];
  /** Per-account databases outside the stores: deleted, never exported. */
  rawDatabases: AccountDatabase[];
  /** The account's own settings files: exported sanitized, deleted with the account. */
  settings: string[];
  /** Named by an export as kept back, never deleted with the account (a legacy Telegram login: Unpair's). */
  preserved: string[];
  /** For a source that pairs this computer (no broker credential): the session artifacts a clean Unpair removes. */
  pairing?: string[];
}

export interface AccountFilesContext {
  env: LayoutEnv;
  /** The home the caller resolves the owner's settings under (macOS keeps them in `~/.olympus`). */
  homeDir?: string;
}

/**
 * Stores only the connector-store mount list places, by its default `dbPath`
 * (`OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON`, pinned in
 * `config/private-host.env`). No worker resolves them, so they are named here:
 * a lifecycle test fails if a mounted `dbPath` is named by no account. Apple
 * Messages is absent on purpose: no install mounts it and its lane is pinned
 * off (identity air-gap), so it owns no store to lose.
 */
const MOUNTED_STORES: Readonly<Record<string, readonly string[]>> = {
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  'reflect.notes': ['reflect-notes.sqlite'],
  'roam.notes': ['roam-notes.sqlite'],
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
};

/**
 * The grandfathered per-family index an install upgraded across the Slice 2
 * cut still holds. Nothing reads it any more, but it sits in the data root,
 * which Delete all removes, so Export copies it and Delete takes it with its
 * account. Each carries its own retired schema marker (never the connector
 * store's), and the env override the deleted reader honored still finds it.
 */
const PRE_CUTOVER_INDEXES: Readonly<Record<string, { file: string; override: string; storeId: string }>> = {
  'gmail.email': { file: 'email-index.sqlite', override: 'OLYMPUS_EMAIL_INDEX_DB_PATH', storeId: 'email-index' },
  'dropbox.files': {
    file: 'dropbox-files-index.sqlite',
    override: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_DB_PATH',
    storeId: 'dropbox-files-index',
  },
  'google_drive.docs': {
    file: 'google-drive-docs-index.sqlite',
    override: 'OLYMPUS_SOURCE_INDEX_DRIVE_INDEX_DB_PATH',
    storeId: 'google-drive-docs-index',
  },
  'telegram.messages': {
    file: 'telegram-messages-index.sqlite',
    override: 'OLYMPUS_SOURCE_INDEX_TELEGRAM_MESSAGES_DB_PATH',
    storeId: 'telegram-messages-index',
  },
  'readwise.library': {
    file: 'readwise-index.sqlite',
    override: 'OLYMPUS_SOURCE_INDEX_READWISE_INDEX_DB_PATH',
    storeId: 'readwise-index',
  },
};

/**
 * The order a source's stores are listed in, where it is not the layout's: as
 * its connector listed them (WhatsApp's protected store first), so the
 * manifest and the messaging resolution golden keep their order.
 */
const STORE_ORDER: Readonly<Record<string, readonly string[]>> = {
  [WHATSAPP_SOURCE_ID]: ['secure_local', 'internal'],
};

/** Ids a source used to answer to, which still name its rows in shared files. */
const SOURCE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  [WHATSAPP_SOURCE_ID]: ['whatsapp.messages'],
};

/** Every source the data lifecycle can hold files for: each with a layout, and each the mount list places. */
export function lifecycleSourceIds(): string[] {
  return [...new Set([...FOLDER_LAYOUT_SOURCES, ...Object.keys(MOUNTED_STORES)])];
}

export function lifecycleSourceAliases(sourceId: string): readonly string[] {
  return SOURCE_ALIASES[sourceId] ?? [];
}

/** The source an id or alias names, when the lifecycle knows it. */
export function lifecycleSourceFor(id: string): string | undefined {
  const trimmed = id.trim();
  return lifecycleSourceIds().find((sourceId) => sourceId === trimmed || lifecycleSourceAliases(sourceId).includes(trimmed));
}

/**
 * Corpora no shipped roster lists, which stores are created with on first
 * need (imported archives' families). A Delete places waiting answers that
 * read them, instead of treating an answer it cannot place as the deleted
 * account's.
 */
export function lifecycleUnrosteredCorpora(): readonly SourceCorpusConfig[] {
  return archiveImportCorpora();
}

/** The account of a source as the registry has it, else as a new one would be placed. */
export function lifecycleAccount(sourceId: string, env: LayoutEnv): AccountFilesAccount {
  return placedAccount(sourceId, env, DEFAULT_ACCOUNT_SLOT);
}

export function accountFiles(account: AccountFilesAccount, context: AccountFilesContext): AccountFiles {
  const { env } = context;
  const sourceId = account.source_id;
  const hasLayout = FOLDER_LAYOUT_SOURCES.includes(sourceId);
  // A data folder that cannot be worked out (a Linux layout that refuses this
  // environment) fails what lives in it, when it is asked for, and nothing else:
  // the raw state outside it still resolves, as its writers resolve it.
  const inDataFolder = <T>(resolve: () => T): { value?: T; error?: unknown } => {
    try {
      return { value: resolve() };
    } catch (error) {
      return { error };
    }
  };
  const folderPath = hasLayout ? inDataFolder(() => accountFolder(account, env)).value : undefined;
  const folder = folderPath !== undefined && (account.layout === 'folder' || existsOnDisk(folderPath)) ? folderPath : undefined;
  const stores = inDataFolder(() => hasLayout
    ? (STORE_ORDER[sourceId] ?? accountStoreNames(sourceId, archiveImportFamilies())).map((name) => accountStorePath(account, name, env))
    : (MOUNTED_STORES[sourceId] ?? []).map((file) => olympusDataPath(env, file)));
  const preCutover = PRE_CUTOVER_INDEXES[sourceId];
  const preCutoverPath = preCutover
    ? inDataFolder(() => env[preCutover.override]?.trim() || olympusDataPath(env, preCutover.file)).value
    : undefined;
  const files: AccountFiles = {
    account,
    ...(folder ? { folder } : {}),
    get stores(): string[] {
      if (stores.error !== undefined) throw stores.error;
      return stores.value!;
    },
    ...(preCutover && preCutoverPath ? { preCutoverIndex: { path: preCutoverPath, storeId: preCutover.storeId } } : {}),
    raw: [],
    rawDatabases: [],
    settings: sourceId === 'dropbox.files' ? [dropboxIngestionPolicyPath(context)] : [],
    preserved: [],
  };
  const pairingContext = { env, layout: account.layout };
  if (sourceId === TELEGRAM_SOURCE_ID) files.pairing = telegramPairingSessionPaths(pairingContext);
  if (sourceId === WHATSAPP_SOURCE_ID) files.pairing = whatsappPairingSessionPaths(pairingContext);
  const raw = (name: AccountRawName, options: { usageDbPath?: string } = {}): string => accountRawPath(account, name, env, options);
  switch (sourceId) {
    case 'local.files':
      // The change snapshots that let a restart catch up without a rescan.
      files.raw.push(raw('watch'));
      break;
    case 'archive.imports':
      // The record of each import and the imports asked for but not yet
      // recorded; and the media files each import bound, by name. The
      // person's own export files are never touched.
      files.raw.push(raw('archive-imports.json'), raw('archive-import-requests.json'));
      files.rawDatabases.push({ path: raw('archive-media-bindings.sqlite'), storeId: ARCHIVE_MEDIA_BINDINGS_STORE_ID });
      break;
    case 'x.bookmarks':
      // X's reconcile snapshots per X user id. The usage ledger beside them is
      // the quota ledger and stays; its sync checkpoints are a forget step.
      files.rawDatabases.push({
        path: raw('x-reconcile.sqlite', { usageDbPath: xBookmarksApiUsageDbPath(env) }),
        storeId: X_BOOKMARKS_RECONCILE_STATE_STORE_ID,
      });
      break;
    case TELEGRAM_SOURCE_ID:
      // The capture spool is Olympus's own copy of every captured message's
      // text, and the drain cursor and gateway state record how far capture
      // has written into it. A legacy account's login is Unpair's, kept back
      // here; a folder account's is in its folder and goes with it.
      if (account.layout === 'folder') {
        files.raw.push(raw('telegram-spool'), raw('telegram-gateway'));
      } else {
        files.raw.push(...legacyTelegramCaptureState(account, env));
        files.preserved.push(...files.pairing!);
      }
      break;
    case WHATSAPP_SOURCE_ID:
      // The spool carries every message's full text, the session the
      // linked-device keys, and media the captured audio: a folder account
      // keeps all of it in its one state folder.
      files.raw.push(...(account.layout === 'folder' ? [raw('whatsapp')] : legacyWhatsAppCaptureState(account, env, files.pairing!)));
      break;
  }
  files.raw = [...new Set(files.raw)];
  return files;
}

/** Every file or folder of the account that is on disk now: the evidence that it holds something. */
export function accountFilesPresent(files: AccountFiles): boolean {
  return [
    ...(files.folder ? [files.folder] : []),
    ...files.stores,
    ...(files.preCutoverIndex ? [files.preCutoverIndex.path] : []),
    ...files.raw,
    ...files.rawDatabases.map((database) => database.path),
    ...files.settings,
    ...files.preserved,
  ].some((path) => path !== ':memory:' && existsOnDisk(path));
}

/**
 * What each messaging source's capture grant says about where its session
 * lives, for the registry the caller names (the grant sits beside it).
 */
export function retainedCaptureGrants(handleRegistryPath: string): Array<{
  source: 'telegram' | 'whatsapp';
  sourceId: string;
  /** The source's name, for a message. */
  label: string;
  evidence: CaptureGrantSessionEvidence;
}> {
  return ([['telegram', TELEGRAM_SOURCE_ID, 'Telegram'], ['whatsapp', WHATSAPP_SOURCE_ID, 'WhatsApp']] as const).map(([source, sourceId, label]) => ({
    source,
    sourceId,
    label,
    evidence: captureGrantSessionEvidence(source, captureGrantPathBeside(source, handleRegistryPath)),
  }));
}

function legacyTelegramCaptureState(account: AccountFilesAccount, env: LayoutEnv): string[] {
  const drainStateDir = env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_STATE_DIR?.trim()
    || join(env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'state'), 'olympus', 'telegram-spool-drain');
  return [
    accountRawPath(account, 'telegram-spool', env),
    env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_CURSOR_PATH?.trim() || join(drainStateDir, 'cursor.json'),
    accountRawPath(account, 'telegram-gateway', env),
  ];
}

function legacyWhatsAppCaptureState(account: AccountFilesAccount, env: LayoutEnv, pairing: readonly string[]): string[] {
  // As the capture/store sync runtime resolves it (an override may name `session.db`).
  const stateDir = whatsappStateDir({ env, layout: account.layout });
  // The transcribe drain reads the captured audio through its own knobs, so a
  // media folder moved out from under the bridge is still named.
  const transcribeStateDir = env.OLYMPUS_WHATSAPP_TRANSCRIBE_STATE_DIR?.trim();
  const transcribeMediaDir = env.OLYMPUS_WHATSAPP_TRANSCRIBE_MEDIA_DIR?.trim()
    || (transcribeStateDir ? join(transcribeStateDir, 'media') : undefined);
  return [
    env.OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR?.trim() || join(stateDir, 'spool'),
    ...pairing,
    join(stateDir, 'media'),
    ...(transcribeMediaDir ? [transcribeMediaDir] : []),
  ];
}

function dropboxIngestionPolicyPath(context: AccountFilesContext): string {
  // macOS keeps the owner's settings under the home the caller names.
  if (!context.homeDir || process.platform === 'linux') return defaultDropboxIngestionPolicyPath(context.env);
  return join(context.homeDir, '.olympus', 'sources', 'dropbox.personal.ingestion.json');
}

/** A link counts: whatever it points at, something is there. */
function existsOnDisk(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
