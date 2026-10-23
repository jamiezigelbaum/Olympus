import { storeCustodyDirectory, storeCustodyLockPath } from './core/store-custody.ts';
import { clearDeleteFenceEntry, fencePathSpellings, readDeleteFence, setDeleteFenceEntry, withDeleteFenceBypass } from './core/delete-fence.ts';
import {
  SECRET_LOCATIONS_SQLITE_STORE_ID,
  TIER_LEDGER_SQLITE_STORE_ID,
  TIER_SNIFFER_SQLITE_STORE_ID,
  secretLocationsPathForStore,
  tierLedgerPathForStore,
  tierSnifferPathForStore,
} from './workers/classification/tier-ledger-path.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Database } from 'bun:sqlite';
import { isUnsupportedDirectorySyncError, writePrivateFileAtomicSync } from './core/atomic-file.ts';
import { OperationError } from './core/operation-error.ts';
import { getFileScopeSource } from './core/file-scope-sources.ts';
import { resolveLinuxSecretPaths } from './core/linux-secret-backend.ts';
import { defaultOlympusConfigDir } from './core/secret-store.ts';
import {
  readSqliteSchemaVersion,
  runSqliteMigrations,
  type SqliteMigration,
  type SqliteMigrationResult,
} from './core/sqlite-migrations.ts';
import {
  REMOTE_CONNECTIONS_STORE_ID,
  remoteConnectionsPreV2BackupPath,
  resolveRemoteConnectionsDbPath,
} from './core/remote-connections.ts';
import {
  openWaitingPrivateQuestionStore,
  WAITING_PRIVATE_QUESTIONS_STORE_ID,
  waitingPrivateQuestionsDbPath,
} from './core/waiting-private-questions.ts';
import { defaultDropboxIngestionPolicyPath } from './core/source-ingestion-policy.ts';
import { defaultSourceIngestionExclusionsPath } from './core/source-ingestion-exclusions.ts';
import { workerSetupEnvPath } from './core/worker-auth.ts';
import { defaultPrivacyProfilePath } from './workers/classification/privacy-profile.ts';
import { defaultTierRulesPath } from './workers/classification/tier-rules.ts';
import { resolveEmbeddingLedgerPath } from './workers/embedding-ledger.ts';
import { resolveClassificationLedgerPath } from './workers/classification-ledger.ts';
import { defaultSourceSchedulerStateDbPath } from './workers/source-scheduler-state.ts';
import { dropboxTierConnectorStoreDbPaths } from './workers/dropbox-files/index.ts';
import { localFilesTierConnectorStoreDbPaths, localFilesWatchDir } from './workers/local-files/store.ts';
import { archiveImportFamilies } from './core/archive-formats.ts';
import { archiveConnectorStoreDbPaths, archiveImportCorpora } from './workers/archive-import/store.ts';
import { ArchiveImportStateStore, defaultArchiveImportStatePath } from './workers/archive-import/state.ts';
import { ArchiveImportRequestStore, archiveImportRequestsPath, withArchiveImportApprovals } from './workers/archive-import/requests.ts';
import {
  defaultGmailConnectorStoreDbPath,
  defaultGmailPublicConnectorStoreDbPath,
  defaultGmailSecureConnectorStoreDbPath,
  defaultGoogleDriveConnectorStoreDbPath,
  defaultGoogleDrivePublicConnectorStoreDbPath,
  defaultGoogleDriveSecureConnectorStoreDbPath,
} from './workers/google-connectors/index.ts';
import {
  defaultInternalTelegramConnectorStoreDbPath,
  defaultProtectedTelegramConnectorStoreDbPath,
} from './workers/telegram-messages/index.ts';
import { defaultReadwiseConnectorStoreDbPath } from './workers/readwise/index.ts';
import { defaultReadwiseSecureConnectorStoreDbPath } from './workers/readwise/tier-set.ts';
import { defaultXBookmarksConnectorStoreDbPath } from './workers/x-bookmarks/index.ts';
import { defaultXBookmarksSecureConnectorStoreDbPath } from './workers/x-bookmarks/tier-set.ts';
import {
  defaultXBookmarksReconcileStateDbPath,
  X_BOOKMARKS_RECONCILE_STATE_STORE_ID,
} from './workers/x-bookmarks/reconcile-state.ts';
import {
  defaultXBookmarksApiUsageDbPath,
  LocalXBookmarksApiUsageStore,
} from './workers/x-bookmarks/live-control.ts';
import {
  defaultWhatsAppConnectorStoreDbPath,
  defaultWhatsAppInternalConnectorStoreDbPath,
} from './workers/whatsapp/index.ts';
import { defaultSovereigntyConfigPath } from './core/sovereignty.ts';
import {
  olympusDataRoots,
  telegramPairingSessionPaths,
  whatsappPairingSessionPaths,
  whatsappStateDir as resolveWhatsAppStateDir,
} from './core/pairing-session-paths.ts';
import { artifactPresence, type UnpairedSourcesRead } from './workers/credential-broker/unpaired-sources.ts';
import { createSourceCorpusRegistry, withSourceCorpora, type SourceCorpusConfig } from './core/source-corpus-registry.ts';
import { defaultFileExtractionJobsDbPath } from './workers/file-extraction/job-names.ts';
import { LocalFileExtractionJobStore } from './workers/file-extraction/job-store.ts';
import { V0_4_PUBLIC_SOURCE_CAPABILITIES } from './core/public-source-capabilities.ts';
import { workerServicePaths, type WorkerServiceState } from './core/worker-service.ts';
import { closeSqliteStore } from './core/sqlite-store.ts';
import { isMediaCachePath, mediaCacheDir, mediaHolderName, releaseMediaCacheFile } from './core/media-cache.ts';
import type { ConnectedHandleRegistry } from './workers/credential-broker/connected-handles.ts';

export interface LifecyclePathContext {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  /**
   * The handle registry the caller is actually running against (the worker's
   * configured one), so the files beside it are protected wherever it lives.
   */
  registryPath?: string;
}

export interface LifecycleSourceSpec {
  sourceId: string;
  /** Backward-compatible or registry-owned ids that resolve to this owner. */
  sourceAliases?: readonly string[];
  label: string;
  sqliteStoreId: string;
  /**
   * Declared only by a family this build still migrates. A legacy per-family
   * index is a custody artifact, never a migration target, so declaring
   * `sqlitePath` alone must not put a store back under a writing loop.
   */
  sqliteMigrations?: () => SqliteMigration[];
  /**
   * The grandfathered per-family index an install upgraded across the Slice 2
   * cut still holds on disk. Nothing reads it any more — that commit deleted
   * the legacy read and replay paths, and the worker helpers that resolved
   * these paths with them — but the file itself was never removed, and it
   * lives inside a known root `delete --all` erases recursively. Dropping it
   * from this inventory therefore did not retire it: it made the documented
   * export-then-delete exit destroy the owner's entire pre-cutover corpus
   * with no copy in the export and no mention in the manifest, exactly the
   * WhatsApp failure recorded above.
   */
  sqlitePath?(context?: LifecyclePathContext): string;
  /**
   * The retired schema marker the legacy index carries, which is NEVER the
   * connector store's. The export records it in the manifest and the
   * external-path delete fence verifies that exact id, so a family declaring
   * `sqlitePath` must declare this too or both would assert the wrong store.
   */
  legacySqliteStoreId?: string;
  /**
   * The shared connector-store databases this family reads and writes today.
   * `delete --all` already erases them with the roots they live in, so export
   * and per-source delete must see them too or they promise what they do not
   * deliver.
   */
  connectorStorePaths?(context?: LifecyclePathContext): string[];
  /**
   * Registry entries for this family's stores that the shipped roster does
   * not list (stores created on first need). Deleting any source places
   * the inbox answers that read them, instead of treating an answer it
   * cannot place as the deleted source's.
   */
  registryCorpora?(): readonly SourceCorpusConfig[];
  /**
   * Raw ingest and session state a family keeps OUTSIDE its SQLite store.
   * WhatsApp is the only family whose complete plaintext corpus arrives this
   * way (a spool the bridge writes and the drain reads) and the only one that
   * keeps live account credentials on disk, so a per-source delete that erased
   * the store alone reported `ok: true` over an untouched message history and
   * a linked-device session. Export never copies these — the spool is raw
   * ingest and the session is secret material — so it reports them as skipped
   * rather than letting the manifest imply it took them.
   */
  rawStatePaths?(context?: LifecyclePathContext): string[];
  /**
   * SQLite state a family keeps beside its store about the provider account
   * the store was filled from, deleted with the source and never exported.
   * X keeps its reconciliation snapshots per X user id: left behind, a
   * per-source delete before connecting a different X account stranded the
   * new account's reconcile on "explicit account migration or state reset is
   * required" (PR #264 review).
   */
  accountStateSqlite?(context?: LifecyclePathContext): Array<{ path: string; sqliteStoreId: string }>;
  /**
   * Account-specific rows a family keeps inside a database that must itself
   * survive the source (X's sync checkpoints beside its API usage ledger).
   * Cleared by a per-source delete; returns the databases it cleared (or, in a
   * dry run, would clear).
   */
  resetAccountState?(context: LifecyclePathContext, dryRun: boolean): string[];
  /**
   * State that must be preserved before a source is stopped or removed, but
   * which the generic export intentionally does not copy. Unlike
   * `rawStatePaths`, these paths are inventory-only and are never added to a
   * delete command. This keeps preservation discovery from silently widening
   * a destructive surface.
   */
  preservationOnlyPaths?(context?: LifecyclePathContext): string[];
  /**
   * The artifacts that make this computer a paired session of the provider
   * (Telegram's mtproto login, WhatsApp's linked-device session). A family that
   * names them has no broker credential to disconnect, so "disconnected" means
   * a CLEAN Unpair: the durable unpaired record says so and none of these is
   * left on disk. Naming them here is also what lets the per-source delete
   * refuse a pairing that is still live.
   */
  pairingSessionPaths?(context?: LifecyclePathContext): string[];
  /**
   * For a source with neither a credential nor a pairing (imported archives):
   * whether it still holds something the person approved in the dashboard,
   * which counts as connected for the per-source delete, and how the person
   * ends it there. A record that cannot be read counts as present.
   */
  approvals?: {
    present(context?: LifecyclePathContext): boolean;
    nextAction: string;
    /**
     * Runs the custody check and the delete under the one exclusion the
     * dashboard's approvals hold while they move between stores, so an
     * approval never lands between the check and the delete.
     */
    exclusive?<T>(context: LifecyclePathContext | undefined, run: () => T): T;
  };
  policyPaths?(context?: LifecyclePathContext): string[];
}

// The schema marker LocalConnectorStore writes (SQLITE_STORE_ID in
// src/workers/connector-store/local-index.ts). It is what the external-path
// fence verifies before deleting a store outside a known Olympus root, so a
// drift here fails closed: the delete refuses rather than removing a stranger.
const CONNECTOR_STORE_SQLITE_STORE_ID = 'connector-store';

export interface DataExportResult {
  ok: true;
  destination: string;
  sourceIds: string[];
  files: string[];
  skipped: string[];
  artifacts: DataExportArtifact[];
}

export interface DataExportArtifact {
  sourceId: string;
  role: 'legacy_store' | 'connector_store' | 'sanitized_config';
  relativePath: string;
  bytes: number;
  sha256: string;
  sqlite?: {
    integrityCheck: 'ok';
    foreignKeyViolations: number;
    expectedStoreId: string;
    schemaVersion: number;
  };
}

export interface DataExportVerificationResult {
  ok: true;
  destination: string;
  artifactCount: number;
  artifacts: Array<{ relativePath: string; bytes: number; sha256: string }>;
}

export interface DataDeleteResult {
  ok: true;
  mode: 'all' | 'source';
  sourceId?: string;
  dryRun: boolean;
  removed: string[];
  missing: string[];
  /** Databases kept with the source's account-specific rows cleared from them. */
  reset?: string[];
}

export interface DataDeleteCustody {
  requirement: 'source_disconnected' | 'worker_inactive';
  ready: boolean;
  observed: 'disconnected' | 'connected' | 'paired' | 'unpair_incomplete' | 'unpair_state_unreadable' | WorkerServiceState | 'unknown_registry' | 'relay_running' | 'engine_loaded';
  next_action?: string;
}

export interface DataDeleteWithCustodyResult extends DataDeleteResult {
  custody: DataDeleteCustody;
}

export interface DataMigrationCheckResult {
  ok: true;
  dryRun: boolean;
  stores: SqliteMigrationResult[];
  skipped: string[];
}

interface DeleteTarget {
  path: string;
  kind: 'known_root' | 'service_unit' | 'source_sqlite' | 'source_sqlite_sidecar' | 'source_state_path' | 'policy_file';
  allowRecursive: boolean;
  sqliteStoreId?: string;
  sqlitePrimaryPath?: string;
  externalSourcePath?: boolean;
}

const DELETE_CONFIRMATION_1 = 'DELETE OLYMPUS DATA';
const DELETE_CONFIRMATION_2 = 'DELETE EVERYTHING';

export function lifecycleSourceSpecs(): LifecycleSourceSpec[] {
  return [
    {
      sourceId: 'gmail.email',
      label: 'Gmail connector stores',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      legacySqliteStoreId: 'email-index',
      sqlitePath: (context) =>
        legacySourceIndexPath(envForContext(context), 'OLYMPUS_EMAIL_INDEX_DB_PATH', 'email-index.sqlite'),
      // The secure store's co-located tier ledger is the set ledger for all
      // three stores, and its secret-locations index sits beside it too.
      connectorStorePaths: (context) => [
        defaultGmailConnectorStoreDbPath(envForContext(context)),
        defaultGmailSecureConnectorStoreDbPath(envForContext(context)),
        defaultGmailPublicConnectorStoreDbPath(envForContext(context)),
      ],
    },
    {
      sourceId: 'dropbox.files',
      label: 'Dropbox files connector store',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      legacySqliteStoreId: 'dropbox-files-index',
      sqlitePath: (context) => legacySourceIndexPath(
        envForContext(context),
        'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_DB_PATH',
        'dropbox-files-index.sqlite',
      ),
      // Every tier store of the lane (P1c); the set ledger and the
      // secret-locations index sit beside the secure (first) one.
      connectorStorePaths: (context) => dropboxTierConnectorStoreDbPaths(envForContext(context)),
      policyPaths: (context) => [defaultDropboxIngestionPolicyPathForHome(context?.homeDir)],
    },
    {
      // No legacy index ever existed: this family is connector-store only.
      sourceId: 'local.files',
      label: 'Files on this computer connector store',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      connectorStorePaths: (context) => localFilesTierConnectorStoreDbPaths(envForContext(context)),
      // The change snapshots that let a restart catch up without a rescan.
      rawStatePaths: (context) => [localFilesWatchDir(envForContext(context))],
    },
    {
      // Connector stores only: one set per family, every archive's items in it.
      sourceId: 'archive.imports',
      label: 'Imported archives connector stores',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      connectorStorePaths: (context) => archiveConnectorStoreDbPaths(archiveImportFamilies(), envForContext(context)),
      registryCorpora: archiveImportCorpora,
      // The record of each import (the chosen paths, file versions, progress)
      // and the imports asked for but not yet recorded. The person's own
      // export files are never touched.
      rawStatePaths: (context) => {
        const statePath = defaultArchiveImportStatePath(envForContext(context));
        return [statePath, archiveImportRequestsPath(statePath)];
      },
      approvals: {
        // An approval still being checked for copies counts too: the check
        // records the import when it finishes, so deleting under it would let
        // an import land after the delete. Either file unreadable counts as
        // present.
        present: (context) => {
          try {
            const statePath = defaultArchiveImportStatePath(envForContext(context));
            if (new ArchiveImportStateStore({ path: statePath }).list().length > 0) return true;
            return new ArchiveImportRequestStore({ path: archiveImportRequestsPath(statePath) }).list()
              .some((request) => request.status === 'checking');
          } catch {
            return true;
          }
        },
        nextAction: 'Under Archives in the local dashboard, cancel any import still being checked (or let it finish) and remove each archive, then rerun the CLI delete.',
        exclusive: (context, run) => withArchiveImportApprovals(defaultArchiveImportStatePath(envForContext(context)), run),
      },
    },
    {
      sourceId: 'google_drive.docs',
      label: 'Google Drive/Docs connector stores',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      legacySqliteStoreId: 'google-drive-docs-index',
      sqlitePath: (context) => legacySourceIndexPath(
        envForContext(context),
        'OLYMPUS_SOURCE_INDEX_DRIVE_INDEX_DB_PATH',
        'google-drive-docs-index.sqlite',
      ),
      connectorStorePaths: (context) => [
        defaultGoogleDriveConnectorStoreDbPath(envForContext(context)),
        defaultGoogleDriveSecureConnectorStoreDbPath(envForContext(context)),
        defaultGoogleDrivePublicConnectorStoreDbPath(envForContext(context)),
      ],
    },
    {
      sourceId: 'telegram.messages',
      label: 'Telegram messages connector stores',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      legacySqliteStoreId: 'telegram-messages-index',
      sqlitePath: (context) => legacySourceIndexPath(
        envForContext(context),
        'OLYMPUS_SOURCE_INDEX_TELEGRAM_MESSAGES_DB_PATH',
        'telegram-messages-index.sqlite',
      ),
      connectorStorePaths: (context) => [
        defaultInternalTelegramConnectorStoreDbPath(envForContext(context)),
        defaultProtectedTelegramConnectorStoreDbPath(envForContext(context)),
      ],
      // The capture spool is Olympus's own copy of every captured message's
      // text, and the drain cursor and gateway state only record how far the
      // capture has written into it (forward cursors, counters), so a delete
      // that left them would keep the raw text and resume from stale marks. The
      // pairing login itself is NOT here: it is the Unpair's, and a re-pair
      // needs the account, not these.
      rawStatePaths: (context) => telegramCaptureStatePaths(envForContext(context)),
      preservationOnlyPaths: (context) => telegramPairingSessionPaths({ env: envForContext(context) }),
      pairingSessionPaths: (context) => telegramPairingSessionPaths({ env: envForContext(context) }),
    },
    {
      sourceId: 'readwise.library',
      label: 'Readwise library connector store',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      legacySqliteStoreId: 'readwise-index',
      sqlitePath: (context) => legacySourceIndexPath(
        envForContext(context),
        'OLYMPUS_SOURCE_INDEX_READWISE_INDEX_DB_PATH',
        'readwise-index.sqlite',
      ),
      // The lane's Private store (P1c) carries the set ledger and the
      // secret-locations index beside it, created or not.
      connectorStorePaths: (context) => [
        defaultReadwiseConnectorStoreDbPath(envForContext(context)),
        defaultReadwiseSecureConnectorStoreDbPath(envForContext(context)),
      ],
    },
    {
      // The legacy X bookmarks index was retired and deleted (2026-07-28), so
      // this family is connector-store only. It was absent from the inventory
      // entirely, which made its corpus unexportable by any command — and
      // invisible even in the manifest's `skipped` list.
      sourceId: 'x.bookmarks',
      label: 'X bookmarks connector store',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      connectorStorePaths: (context) => [
        defaultXBookmarksConnectorStoreDbPath(envForContext(context)),
        defaultXBookmarksSecureConnectorStoreDbPath(envForContext(context)),
      ],
      // The API usage store stays: it is the quota ledger. Its sync
      // checkpoints are the previous account's and are cleared.
      resetAccountState: (context, dryRun) => {
        const usagePath = defaultXBookmarksApiUsageDbPath(envForContext(context));
        if (usagePath === ':memory:' || !existsSync(usagePath)) return [];
        if (!dryRun) {
          const usage = new LocalXBookmarksApiUsageStore(usagePath);
          try {
            usage.clearSyncState();
          } finally {
            usage.close();
          }
        }
        return [usagePath];
      },
      accountStateSqlite: (context) => {
        const env = envForContext(context);
        return [{
          path: defaultXBookmarksReconcileStateDbPath(env, defaultXBookmarksApiUsageDbPath(env)),
          sqliteStoreId: X_BOOKMARKS_RECONCILE_STATE_STORE_ID,
        }];
      },
    },
    {
      // Connector-store only, like X: the WhatsApp corpus never had a legacy
      // per-family index. It was absent from this inventory while living
      // inside a known root that `delete --all` removes recursively, so the
      // documented export-then-delete exit destroyed the S4 chat history and
      // its local voice-note transcriptions with no copy in the export — and
      // said nothing about it, because a store that belongs to no spec is not
      // even reported as skipped.
      sourceId: 'whatsapp.personal.messages',
      sourceAliases: ['whatsapp.messages'],
      label: 'WhatsApp messages connector store',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      connectorStorePaths: (context) => [
        defaultWhatsAppConnectorStoreDbPath(envForContext(context)),
        defaultWhatsAppInternalConnectorStoreDbPath(envForContext(context)),
      ],
      rawStatePaths: (context) => whatsappRawStatePaths(envForContext(context)),
      pairingSessionPaths: (context) => whatsappPairingSessionPaths({ env: envForContext(context) }),
    },
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
    {
      // Reflect and Roam reach the read path only through the connector-store
      // mount list, so — unlike every other family — there is no worker helper
      // to import: the archive-import connectors hand items to the shared store
      // and never resolve its path. That made them the last two live corpora
      // belonging to no spec, with the WhatsApp failure above verbatim: both
      // sit in `~/.local/share/openclaw/olympus`, a known root `delete --all`
      // removes recursively, while export copied neither and reported neither
      // as skipped. Apple Messages is deliberately absent: no install mounts
      // it and its lane is pinned off (identity air-gap), so it owns no store
      // to lose. If that ever changes, the mount is what the inventory test
      // reads, and it will fail until an entry exists here.
      sourceId: 'reflect.notes',
      label: 'Reflect notes connector store',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      connectorStorePaths: (context) => [mountedConnectorStoreDbPath(envForContext(context), 'reflect-notes.sqlite')],
    },
    {
      sourceId: 'roam.notes',
      label: 'Roam notes connector store',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      connectorStorePaths: (context) => [mountedConnectorStoreDbPath(envForContext(context), 'roam-notes.sqlite')],
    },
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
  ];
}

/**
 * The default the connector-store mount list declares for a store no worker
 * owns a path helper for (`OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON`, whose
 * host value is pinned in `config/private-host.env`). The mount list is data,
 * not code, so nothing type-checks this pairing: a lifecycle test reads that
 * manifest and fails if any mounted `dbPath` is produced by no spec, which is
 * what keeps a future mount from drifting back out of the export inventory.
 */
function mountedConnectorStoreDbPath(env: Record<string, string | undefined>, fileName: string): string {
  return olympusSharedDataFile(env, fileName);
}

/**
 * Where a grandfathered per-family index sits on an install that upgraded
 * across the Slice 2 cut. The worker helpers that used to resolve these paths
 * were deleted with the readers, so the inventory that must still account for
 * the files owns their resolution now — the same way it owns the mount-list
 * defaults above. `overrideKey` is the env knob the deleted reader honoured,
 * so an install that moved an index is still found where it actually is
 * rather than reported absent while `delete --all` takes it.
 */
function legacySourceIndexPath(
  env: Record<string, string | undefined>,
  overrideKey: string,
  fileName: string,
): string {
  return env[overrideKey]?.trim() || olympusSharedDataFile(env, fileName);
}

function olympusSharedDataFile(env: Record<string, string | undefined>, fileName: string): string {
  return join(
    env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'share'),
    'openclaw',
    'olympus',
    fileName,
  );
}

/**
 * Resolved the way the canonical capture/store sync runtime resolves it
 * (`scripts/whatsapp-live-sync.ts`), which is the only resolution that finds
 * the corpus where it actually is. The reader-side twin in
 * `src/workers/source-ingestion-ledger.ts` never learned about
 * `OLYMPUS_WHATSAPP_STATE_DIR`, so an install that moves the state directory
 * left the export snapshotting a path the drain had never written while
 * `delete --all` erased the real store with the root around it. With the knob
 * unset — every default install — this returns exactly what it always did.
 */
function whatsappStateDir(env: Record<string, string | undefined>): string {
  return resolveWhatsAppStateDir({ env });
}

/**
 * Everything the WhatsApp bridge and its drains keep in the state directory
 * beside the connector store. The list mirrors the artifacts the installer
 * itself locks down (`scripts/ops/install-private-host-whatsapp-bridge-systemd.sh`):
 * the JSONL spool that carries every message's full text, the whatsmeow
 * session database holding the linked-device keys, the pairing QR, and the
 * captured audio. The store path has its own independent overrides, so these
 * are resolved from the state-dir knobs rather than from `dirname(store)`.
 */
function whatsappRawStatePaths(env: Record<string, string | undefined>): string[] {
  const stateDir = whatsappStateDir(env);
  // The transcribe drain reads the captured audio through its own knobs, so a
  // media directory moved out from under the bridge is still named here.
  const transcribeStateDir = env.OLYMPUS_WHATSAPP_TRANSCRIBE_STATE_DIR?.trim();
  const transcribeMediaDir = env.OLYMPUS_WHATSAPP_TRANSCRIBE_MEDIA_DIR?.trim()
    || (transcribeStateDir ? join(transcribeStateDir, 'media') : undefined);
  return [...new Set([
    env.OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR?.trim() || join(stateDir, 'spool'),
    // The pairing artifacts, named once (see core/pairing-session-paths.ts) so
    // this wider custody list and the dashboard's narrow Unpair cannot drift
    // onto two different resolutions of the same session.
    ...whatsappPairingSessionPaths({ env }),
    join(stateDir, 'media'),
    ...(transcribeMediaDir ? [transcribeMediaDir] : []),
  ])];
}

function telegramCaptureStatePaths(env: Record<string, string | undefined>): string[] {
  const home = env.HOME?.trim() || homedir();
  const dataHome = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  const stateHome = env.XDG_STATE_HOME?.trim() || join(home, '.local', 'state');
  const spoolDir = env.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR?.trim()
    || env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR?.trim()
    || join(dataHome, 'olympus', 'telegram-capture', 'spool');
  const gatewayStateDir = env.OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR?.trim()
    || join(stateHome, 'olympus', 'telegram-capture-gateway');
  const drainStateDir = env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_STATE_DIR?.trim()
    || join(stateHome, 'olympus', 'telegram-spool-drain');
  const cursorPath = env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_CURSOR_PATH?.trim()
    || join(drainStateDir, 'cursor.json');
  return [...new Set([spoolDir, cursorPath, gatewayStateDir])];
}

export function exportOlympusData(options: {
  destination: string;
  sourceId?: string;
} & LifecyclePathContext): DataExportResult {
  const destination = requirePath(options.destination, '--output');
  const selected = selectSources(options.sourceId);
  // Computed BEFORE anything is created: once mkdir -p has run, the directories
  // it made are indistinguishable from the ones that were already there.
  const durabilityBoundary = exportDurabilityBoundary(destination);
  makeDurableDirectory(destination, durabilityBoundary);
  // The manifest is the commit record for THIS run, and a retry into a reused
  // destination immediately starts overwriting the snapshots the previous run's
  // manifest describes. Revoking it first costs one unlink; leaving it standing
  // lets a run that dies partway through present a mixture of two exports as a
  // completed one.
  rmSync(join(destination, 'manifest.json'), { force: true });
  syncDirectorySync(destination);
  const files: string[] = [];
  const skipped: string[] = [];
  const artifacts: DataExportArtifact[] = [];

  for (const source of selected) {
    const sourceRoot = join(destination, 'sources', safePathSegment(source.sourceId));
    makeDurableDirectory(sourceRoot, durabilityBoundary);
    const legacyIndexPath = source.sqlitePath?.(options);
    if (legacyIndexPath) {
      exportSqliteStore({
        sqlitePath: legacyIndexPath,
        destinationRoot: sourceRoot,
        exportRoot: destination,
        sourceId: source.sourceId,
        role: 'legacy_store',
        expectedStoreId: legacyStoreIdFor(source),
        files,
        skipped,
        artifacts,
      });
    }
    for (const storePath of source.connectorStorePaths?.(options) ?? []) {
      exportSqliteStore({
        sqlitePath: storePath,
        destinationRoot: sourceRoot,
        exportRoot: destination,
        sourceId: source.sourceId,
        role: 'connector_store',
        expectedStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
        files,
        skipped,
        artifacts,
      });
    }
    for (const policyPath of source.policyPaths?.(options) ?? []) {
      const destinationPath = join(sourceRoot, basename(policyPath));
      if (copySanitizedJsonIfPresent(policyPath, destinationPath, files, skipped)) {
        artifacts.push(fileArtifact(destination, destinationPath, source.sourceId, 'sanitized_config'));
      }
    }
    // Raw ingest and session state are never copied — the spool is unnormalized
    // input the store already holds, and the session is the secret material
    // this export exists to leave behind. They are still named, because a
    // manifest that omits them entirely is how the owner learns too late that
    // `delete --all` took something the export never had.
    for (const statePath of source.rawStatePaths?.(options) ?? []) skipped.push(statePath);
    for (const state of source.accountStateSqlite?.(options) ?? []) skipped.push(state.path);
    for (const statePath of source.preservationOnlyPaths?.(options) ?? []) skipped.push(statePath);
  }

  // Remote-agent connections are credentials (token digests), which an export
  // leaves behind like every other secret. Named, so the manifest says so.
  // Waiting private questions are Private-derived questions kept only until
  // answered on this computer: never exported, named like the connections.
  if (options.sourceId === undefined) {
    const connectionsPath = resolveRemoteConnectionsDbPath(envForContext(options));
    for (const path of [connectionsPath, remoteConnectionsPreV2BackupPath(connectionsPath), waitingPrivateQuestionsDbPath(connectionsPath)]) {
      if (existsSync(path)) skipped.push(path);
    }
  }

  const configRoot = join(destination, 'config');
  makeDurableDirectory(configRoot, durabilityBoundary);
  for (const [sourcePath, destinationPath] of [
    [join(resolveHome(options.homeDir), '.olympus', 'config.json'), join(configRoot, 'config.json')],
    [defaultSovereigntyConfigPathForHome(options.homeDir), join(configRoot, 'sovereignty.json')],
  ] as const) {
    if (copySanitizedJsonIfPresent(sourcePath, destinationPath, files, skipped)) {
      artifacts.push(fileArtifact(destination, destinationPath, 'olympus.config', 'sanitized_config'));
    }
  }
  // The manifest is the export's commit record, so it is published LAST and
  // atomically. A manifest that reaches the disk before the data it describes
  // is what turns "export, then delete" into silent loss: the owner reads a
  // success they do not have.
  writePrivateFileAtomicSync(join(destination, 'manifest.json'), JSON.stringify({
    kind: 'olympus_data_export',
    version: 2,
    exported_at: new Date().toISOString(),
    source_ids: selected.map((source) => source.sourceId),
    secrets_excluded: true,
    files,
    skipped,
    artifacts,
  }, null, 2));
  files.push(join(destination, 'manifest.json'));

  return { ok: true, destination, sourceIds: selected.map((source) => source.sourceId), files, skipped, artifacts };
}

export function verifyOlympusDataExport(options: { destination: string }): DataExportVerificationResult {
  const destination = resolve(requirePath(options.destination, '--input'));
  const manifestPath = join(destination, 'manifest.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    kind?: unknown;
    version?: unknown;
    artifacts?: unknown;
  };
  if (parsed.kind !== 'olympus_data_export' || parsed.version !== 2 || !Array.isArray(parsed.artifacts)) {
    throw new OperationError('source_index_error', 'Olympus data export manifest is unsupported or incomplete.');
  }
  const verified: Array<{ relativePath: string; bytes: number; sha256: string }> = [];
  for (const value of parsed.artifacts) {
    const artifact = parseExportArtifact(value);
    const path = resolve(destination, artifact.relativePath);
    if (!isSameOrInsidePath(path, destination) || path === destination) {
      throw new OperationError('source_index_error', 'Olympus data export manifest contains an unsafe artifact path.');
    }
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size !== artifact.bytes || sha256File(path) !== artifact.sha256) {
      throw new OperationError(
        'source_index_error',
        `Olympus data export artifact failed verification: ${artifact.relativePath}`,
      );
    }
    if (artifact.sqlite) assertSqliteSnapshotIntact(path, artifact.relativePath);
    verified.push({ relativePath: artifact.relativePath, bytes: artifact.bytes, sha256: artifact.sha256 });
  }
  return { ok: true, destination, artifactCount: verified.length, artifacts: verified };
}

/**
 * What a per-source delete would remove, decided and checked now: the resolved
 * target paths after containment and protection (every target, whatever its
 * kind) and the target-safety checks, and the corpora the source owns. It
 * changes nothing and throws when the delete would be refused. A deletion
 * intent records this, and applying the intent re-derives it and refuses on
 * any difference.
 */
export function planSourceDelete(options: { sourceId: string; verifiedPrimaries?: readonly string[] } & LifecyclePathContext): {
  sourceId: string;
  corpora: string[];
  targets: string[];
  /** External SQLite primaries proven to be Olympus stores by this check. */
  verifiedPrimaries: string[];
  /** Where each target really is (symlinks resolved) and the directory it hangs from. */
  bindings: TargetBinding[];
} {
  const selectedSource = requireSource(options.sourceId);
  const uniqueDeleteTargets = markRelocatedStores(uniqueTargets(sourceDeleteTargets(selectedSource, options)), options);
  assertRawStateTargetsContained(uniqueDeleteTargets, options, selectedSource);
  const verifiedPrimaries = assertTargetsSafe(uniqueDeleteTargets, options.verifiedPrimaries);
  const corpora = createSourceCorpusRegistry().list()
    .filter((c) => c.sourceId === selectedSource.sourceId || selectedSource.sourceAliases?.includes(c.sourceId))
    .map((c) => c.corpusId)
    .sort();
  return {
    sourceId: selectedSource.sourceId,
    corpora,
    targets: uniqueDeleteTargets.map((target) => resolve(target.path)).sort(),
    verifiedPrimaries: [...new Set([...verifiedPrimaries, ...(options.verifiedPrimaries ?? []).map((path) => resolve(path))])].sort(),
    bindings: targetBindings(uniqueDeleteTargets),
  };
}

/**
 * An approved target's real destination. A path is only a name: a symlinked
 * Olympus root retargeted, or a directory above a target swapped, between the
 * request and the restart leaves every recorded string intact while the delete
 * would land on something else. The binding records the canonical destination
 * and the identity (inode) of the nearest existing directory above it.
 */
export interface TargetBinding {
  path: string;
  real: string;
  anchor: string;
  anchor_ino: number;
  /** Device of the anchor: an inode alone does not survive a mount being replaced. Absent in records from before it was kept. */
  anchor_dev?: number;
}

function nearestExistingDirectory(path: string): string {
  let current = dirname(resolve(path));
  for (;;) {
    try {
      if (lstatSync(current).isDirectory() || existsSync(current)) return current;
    } catch { /* keep climbing */ }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function identityOf(path: string): { ino: number; dev: number } {
  try { const info = statSync(path); return { ino: info.ino, dev: info.dev }; } catch { return { ino: -1, dev: -1 }; }
}

export function targetBindings(targets: readonly DeleteTarget[]): TargetBinding[] {
  return targets.map((target) => {
    const anchor = nearestExistingDirectory(target.path);
    const identity = identityOf(anchor);
    return { path: resolve(target.path), real: canonicalPath(target.path), anchor, anchor_ino: identity.ino, anchor_dev: identity.dev };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The first approved target whose real destination or anchor directory is no longer what was approved. */
export function changedBinding(
  expected: readonly TargetBinding[],
  actual: readonly TargetBinding[],
  removedPaths: readonly string[] = [],
): string | undefined {
  const now = new Map(actual.map((binding) => [binding.path, binding]));
  for (const binding of expected) {
    // A target this same delete already removed (or one inside a removed folder)
    // is judged by the removal that took it, not by its vanished anchor.
    if (removedPaths.some((removed) => binding.path === removed || binding.path.startsWith(`${removed}${sep}`))) continue;
    const current = now.get(binding.path);
    // The target must still resolve to the same real place, and the approved
    // directory above it must still be the same directory.
    const identity = identityOf(binding.anchor);
    if (!current || current.real !== binding.real || identity.ino !== binding.anchor_ino
      || (binding.anchor_dev !== undefined && identity.dev !== binding.anchor_dev)) {
      return binding.path;
    }
  }
  return undefined;
}

export function deleteOlympusData(options: {
  all?: boolean;
  sourceId?: string;
  dryRun?: boolean;
  /** Primaries an earlier check of this same delete proved (see assertTargetsSafe). */
  verifiedPrimaries?: readonly string[];
  /** The destinations the owner's request approved; any change refuses before each removal. */
  expectedBindings?: readonly TargetBinding[];
  /**
   * Called once, after every non-mutating preparation succeeded and before the
   * first mutation. A failure before this point is a plain refusal (nothing
   * changed, nothing fenced); from here on the delete has started and the
   * source's stores stay fenced until it finishes.
   */
  onBegin?: () => void;
} & LifecyclePathContext): DataDeleteResult {
  // A started delete finishes through stores the fence keeps shut to everyone else.
  return withDeleteFenceBypass(() => deleteOlympusDataFenced(options));
}

function deleteOlympusDataFenced(options: {
  all?: boolean;
  sourceId?: string;
  dryRun?: boolean;
  verifiedPrimaries?: readonly string[];
  expectedBindings?: readonly TargetBinding[];
  onBegin?: () => void;
} & LifecyclePathContext): DataDeleteResult {
  if (options.all === true && options.sourceId) {
    throw new OperationError('invalid_params', 'Use either --all or --source, not both.');
  }
  if (options.all !== true && !options.sourceId) {
    throw new OperationError('invalid_params', 'Data delete requires --all or --source <id>.');
  }

  const selectedSource = options.all === true ? undefined : requireSource(options.sourceId);
  const targets = options.all === true
    ? allDeleteTargets(options)
    : sourceDeleteTargets(selectedSource!, options);
  const removed: string[] = [];
  const missing: string[] = [];
  const uniqueDeleteTargets = markRelocatedStores(uniqueTargets(targets), options);
  // Before anything is removed or even checked one by one: a recursive raw-state
  // target must be provably Olympus's own and nobody else's (see
  // assertRawStateTargetsContained). A refusal here deletes nothing.
  assertRawStateTargetsContained(uniqueDeleteTargets, options, selectedSource);
  assertTargetsSafe(uniqueDeleteTargets, options.verifiedPrimaries);
  // A source's photo copies live in the shared media cache. Every store's
  // references are read before anything is deleted; each copy is released
  // only once its stores are gone, and removed unless another source's store
  // still holds it. A store that survives (a failed removal) keeps its holds;
  // one interrupted after deletion leaves markers the cache sweep drops,
  // because their holder is gone.
  const sourceMedia = selectedSource
    ? readSourceMedia(selectedSource.connectorStorePaths?.(options) ?? [])
    : [];
  // Before anything is removed: a database that will not open fails the
  // delete with every store still in place (a dry pass of the reset).
  const resetPreview = selectedSource?.resetAccountState?.(options, true) ?? [];
  const mutating = options.dryRun !== true;
  const removedPaths: string[] = [];
  // Every destructive step checks that the approved destinations are still
  // where they were approved, so nothing is removed through a replaced folder.
  const assertBound = () => {
    if (!mutating || !options.expectedBindings) return;
    const moved = changedBinding(options.expectedBindings, targetBindings(uniqueDeleteTargets), removedPaths);
    if (moved) {
      throw new OperationError(
        'invalid_params',
        `Refusing to delete ${moved}: it, or a directory above it, is not where it was when the delete was approved.`,
        'Ask for the delete again once the folders are settled.',
      );
    }
  };
  if (mutating && selectedSource) {
    // Last check before the first mutation, then the fence, then the caller's
    // own record: from here the delete has started.
    assertBound();
    const home = resolveHome(options.homeDir);
    const existing = readDeleteFence(home).entries.find((entry) => entry.source_id === selectedSource.sourceId);
    setDeleteFenceEntry({
      source_id: selectedSource.sourceId,
      paths: fencePathSpellings(uniqueDeleteTargets.map((target) => target.sqlitePrimaryPath ?? target.path)
        .concat(uniqueDeleteTargets.map((target) => target.path))),
      verified_primaries: [...new Set([...(existing?.verified_primaries ?? []), ...(options.verifiedPrimaries ?? []).map((path) => resolve(path))])].sort(),
      since: existing?.since ?? new Date().toISOString(),
    }, home);
    options.onBegin?.();
  }
  assertBound();
  const reset = mutating ? selectedSource?.resetAccountState?.(options, false) ?? [] : resetPreview;
  // Erase dependent private answers before the source bytes. Pending
  // questions have no known dependency yet, so delete them too; their ids
  // disappear and generation-fenced in-flight completions cannot reinsert.
  if (selectedSource && mutating) {
    const inboxPath = waitingPrivateQuestionsDbPath(resolveRemoteConnectionsDbPath(envForContext(options)));
    if (existsSync(inboxPath)) {
      assertBound();
      const inbox = openWaitingPrivateQuestionStore(inboxPath);
      try {
        const registry = createSourceCorpusRegistry(
          withSourceCorpora(undefined, lifecycleSourceSpecs().flatMap((spec) => spec.registryCorpora?.() ?? [])),
        ).list();
        const corpora = registry.filter(c => c.sourceId === selectedSource.sourceId || selectedSource.sourceAliases?.includes(c.sourceId)).map(c => c.corpusId);
        const count = inbox.deleteForCorpora(corpora, registry.map(c => c.corpusId));
        if (count > 0) removed.push(`${inboxPath} (private answers: ${count})`);
      } finally { inbox.close(); }
    }
    // The shared file-extraction queue holds this source's job rows (file
    // names, derivation metadata) outside its own stores. Cleared by corpus,
    // from the registry, so no source is named here.
    const jobsPath = defaultFileExtractionJobsDbPath(envForContext(options));
    if (jobsPath !== ':memory:' && existsSync(jobsPath)) {
      assertBound();
      const corpora = createSourceCorpusRegistry().list()
        .filter(c => c.sourceId === selectedSource.sourceId || selectedSource.sourceAliases?.includes(c.sourceId))
        .map(c => c.corpusId);
      const jobs = new LocalFileExtractionJobStore(jobsPath);
      try {
        const count = jobs.deleteForCorpora(corpora);
        if (count > 0) removed.push(`${jobsPath} (extraction jobs: ${count})`);
      } finally { jobs.close(); }
    }
  }
  for (const target of uniqueDeleteTargets) {
    if (!existsSync(target.path)) {
      missing.push(target.path);
      continue;
    }
    removed.push(target.path);
    if (mutating) {
      assertBound();
      rmSync(target.path, { recursive: target.allowRecursive, force: true });
      removedPaths.push(resolve(target.path));
    }
  }
  assertBound();
  removed.push(...releaseSourceMedia(sourceMedia, options.dryRun === true));
  // Finished: the stores are gone, so the fence has nothing left to keep shut.
  if (mutating && selectedSource) clearDeleteFenceEntry(selectedSource.sourceId, resolveHome(options.homeDir));

  return {
    ok: true,
    mode: options.all === true ? 'all' : 'source',
    ...(selectedSource ? { sourceId: selectedSource.sourceId } : {}),
    dryRun: options.dryRun === true,
    removed,
    missing,
    ...(reset.length > 0 ? { reset } : {}),
  };
}

/**
 * Public CLI custody wrapper around the mechanical delete primitive.
 *
 * A per-source delete may run while the worker stays up only after the source
 * has been disconnected, which removes it from the active scheduler before
 * any store bytes can be removed. Delete-all instead requires the supervised
 * worker to be inactive or absent. Dry runs never mutate and report an unmet
 * prerequisite so the owner can preview first.
 */
export function deleteOlympusDataWithCustody(options: {
  all?: boolean;
  sourceId?: string;
  dryRun?: boolean;
  verifiedPrimaries?: readonly string[];
  expectedBindings?: readonly TargetBinding[];
  onBegin?: () => void;
  connectedRegistry?: ConnectedHandleRegistry;
  unpairedSources?: UnpairedSourcesRead;
  artifactPresence?: (path: string) => 'gone' | 'present' | 'unknown';
  /** Source ids connected on this computer without a credential (see core/this-computer.ts). */
  thisComputerSources?: readonly string[];
  /** The this-computer record exists but cannot be read: a this-computer source cannot be proven disconnected. */
  thisComputerStateUnreadable?: boolean;
  workerState?: WorkerServiceState;
  /** A remote-access relay child is running (it would recreate its keys and keep forwarding). */
  relayRunning?: boolean;
  /**
   * The standalone engine's LaunchAgent is loaded. Running or not, launchd
   * keeps it alive and would start its worker again mid-delete.
   */
  engineLoaded?: boolean;
} & LifecyclePathContext): DataDeleteWithCustodyResult {
  // A source whose approvals move between stores is checked and deleted
  // under their exclusion; every other source as before.
  const exclusive = options.dryRun !== true && options.sourceId
    ? lifecycleSourceSpecs().find((entry) => entry.sourceId === options.sourceId?.trim() || entry.sourceAliases?.includes(options.sourceId!.trim()))?.approvals?.exclusive
    : undefined;
  const run = (): DataDeleteWithCustodyResult => deleteUnderCustody(options);
  return exclusive ? exclusive(options, run) : run();
}

function deleteUnderCustody(options: Parameters<typeof deleteOlympusDataWithCustody>[0]): DataDeleteWithCustodyResult {
  const custody = dataDeleteCustody(options);
  if (options.dryRun !== true && !custody.ready) {
    throw new OperationError(
      'invalid_params',
      custody.requirement === 'source_disconnected'
        // Unpair or Disconnect by what the SOURCE is (a paired session), never
        // by what custody happened to observe: an unreadable registry on a
        // Dropbox delete is still a Disconnect source.
        ? requireSource(options.sourceId).pairingSessionPaths
          ? `Unpair ${options.sourceId} cleanly before deleting its local data (${custody.observed.replace(/_/g, ' ')}).`
          : `Disconnect ${options.sourceId} before deleting its local data.`
        : custody.observed === 'relay_running'
          ? 'Turn remote access off before deleting local data: the relay process is still running.'
          : custody.observed === 'engine_loaded'
            ? 'Stop the Olympus engine before deleting local data: launchd would start it again.'
            : 'Stop or uninstall the Olympus worker before deleting local data.',
      custody.next_action,
    );
  }
  return {
    ...deleteOlympusData(options),
    custody,
  };
}

/**
 * A running worker holds a source's stores open (and may be writing to them).
 * Deleting under it leaves it serving deleted rows from files it no longer
 * owns. The CLI has no authenticated channel to the engine's dashboard route,
 * which is the path that waits for running requests, fences reads and
 * restarts the worker to reopen its stores, so a per-source delete from the
 * CLI is refused while one runs, naming that route. A preview mutates nothing
 * and is always allowed.
 */
export function assertNoRunningWorkerForSourceDelete(input: {
  sourceId: string;
  dryRun: boolean;
  engineLoaded: boolean;
  workerState: WorkerServiceState;
}): void {
  // Destructive delete only after `inactive` or `missing` is positively
  // established with no supervising engine; unknown, transitioning, failed
  // (a deactivating unit, an inspection failure) all mean "cannot prove".
  const provenStopped = !input.engineLoaded && (input.workerState === 'inactive' || input.workerState === 'missing');
  if (input.dryRun || provenStopped) return;
  throw new OperationError(
    'invalid_params',
    `Olympus is running or its state could not be confirmed stopped (${input.engineLoaded ? 'engine loaded' : input.workerState}), so it could keep serving ${input.sourceId} from the stores this delete removes. Nothing was deleted.`,
    'Use Delete indexed data on the source in the Olympus dashboard (it also reopens the worker\'s stores), or run olympus engine stop (olympus worker stop for a legacy worker), then retry.',
  );
}

export function dataDeleteCustody(options: {
  all?: boolean;
  sourceId?: string;
  connectedRegistry?: ConnectedHandleRegistry;
  thisComputerSources?: readonly string[];
  /** The this-computer record exists but cannot be read: a this-computer source cannot be proven disconnected. */
  thisComputerStateUnreadable?: boolean;
  /**
   * The durable unpaired-source record, read the way the dashboard reads it
   * (reconciled against the disk). Required for a paired-session source.
   */
  unpairedSources?: UnpairedSourcesRead;
  /** Tests inject disk presence; real callers leave it. */
  artifactPresence?: (path: string) => 'gone' | 'present' | 'unknown';
  workerState?: WorkerServiceState;
  relayRunning?: boolean;
  engineLoaded?: boolean;
} & LifecyclePathContext): DataDeleteCustody {
  if (options.all === true && options.sourceId) {
    throw new OperationError('invalid_params', 'Use either --all or --source, not both.');
  }
  if (options.all !== true && !options.sourceId) {
    throw new OperationError('invalid_params', 'Data delete requires --all or --source <id>.');
  }

  const source = options.sourceId ? requireSource(options.sourceId) : undefined;
  const publicCapability = source
    ? V0_4_PUBLIC_SOURCE_CAPABILITIES.find((candidate) =>
        candidate.source_id === source.sourceId || source.sourceAliases?.includes(candidate.source_id)
      )
    : undefined;
  if (publicCapability) {
    if (!options.connectedRegistry || (options.connectedRegistry.dropped?.length ?? 0) > 0) {
      return {
        requirement: 'source_disconnected',
        ready: false,
        observed: 'unknown_registry',
        next_action: 'Repair the Olympus connected-handle registry, then Disconnect this source and retry.',
      };
    }
    const lane = publicCapability.doctor_lane;
    // A source with no credential has no handle to disconnect; it
    // is connected in the this-computer record instead, which is checked here.
    const connected = (lane !== undefined
      && options.connectedRegistry.handles.some((handle) => handle.provider === lane.provider))
      || (options.thisComputerSources?.includes(source!.sourceId) ?? false);
    if (options.thisComputerStateUnreadable === true && getFileScopeSource(source!.sourceId)?.account === 'this_computer') {
      return {
        requirement: 'source_disconnected',
        ready: false,
        observed: 'unknown_registry',
        next_action: 'Repair or remove the Olympus this-computer record (this-computer.json beside the handle registry), then retry.',
      };
    }
    const pairingPaths = source!.pairingSessionPaths?.(options);
    if (connected) {
      // A paired-session source ends with Unpair, not Disconnect.
      return pairingPaths
        ? {
            requirement: 'source_disconnected',
            ready: false,
            observed: 'paired',
            next_action: 'Use Unpair in the local dashboard, then rerun the CLI delete.',
          }
        : {
            requirement: 'source_disconnected',
            ready: false,
            observed: 'connected',
            next_action: 'Use Disconnect in the local dashboard, then rerun the CLI delete.',
          };
    }
    if (source!.approvals?.present(options)) {
      return {
        requirement: 'source_disconnected',
        ready: false,
        observed: 'connected',
        next_action: source!.approvals.nextAction,
      };
    }
    // A paired-session source (Telegram, WhatsApp) has no handle to disconnect
    // and its card infers a live session from sync evidence, so "no handle" is
    // not "disconnected". Only a CLEAN Unpair is: the unpaired record says
    // `unpaired` and no pairing artifact is left on disk. Anything else is a
    // pairing that is live, half-removed, or whose state cannot be read.
    if (pairingPaths) {
      const read = options.unpairedSources;
      if (!read || read.status === 'unreadable') {
        return {
          requirement: 'source_disconnected',
          ready: false,
          observed: 'unpair_state_unreadable',
          next_action: 'Repair the Olympus unpaired-source record, then Unpair this source and retry.',
        };
      }
      const record = read.status === 'ok'
        ? read.records.find((candidate) => candidate.source_id === source!.sourceId)
        : undefined;
      if (!record) {
        return {
          requirement: 'source_disconnected',
          ready: false,
          observed: 'paired',
          next_action: 'Use Unpair in the local dashboard, then retry.',
        };
      }
      const presence = options.artifactPresence ?? artifactPresence;
      if (record.state !== 'unpaired' || pairingPaths.some((path) => presence(path) !== 'gone')) {
        return {
          requirement: 'source_disconnected',
          ready: false,
          observed: record.state === 'unpaired' ? 'paired' : 'unpair_incomplete',
          next_action: 'Finish Unpair in the local dashboard (remove what it lists), then retry.',
        };
      }
    }
    return {
      requirement: 'source_disconnected',
      ready: true,
      observed: 'disconnected',
    };
  }

  if (options.engineLoaded === true) {
    return {
      requirement: 'worker_inactive',
      ready: false,
      observed: 'engine_loaded',
      next_action: 'Run olympus engine stop (it stays stopped until olympus engine start), check olympus engine status, then retry.',
    };
  }
  const workerState = options.workerState;
  const ready = workerState === 'inactive' || workerState === 'missing';
  // Like the worker, the remote-access relay child must be down: it holds its
  // keys and state under the data root and would keep forwarding to (and
  // re-creating) what the delete removes.
  if (ready && options.all === true && options.relayRunning === true) {
    return {
      requirement: 'worker_inactive',
      ready: false,
      observed: 'relay_running',
      next_action: 'Run openclaw config set plugins.entries.olympus.config.remote.enabled false (or stop the OpenClaw Gateway), check olympus connections status, then retry.',
    };
  }
  return {
    requirement: 'worker_inactive',
    ready,
    observed: workerState ?? 'unknown',
    ...(!ready
      ? { next_action: 'Run olympus worker stop (or olympus worker uninstall), verify status, then retry.' }
      : {}),
  };
}

export function runDataMigrations(options: {
  dryRun: boolean;
  sourceId?: string;
} & LifecyclePathContext): DataMigrationCheckResult {
  const stores: SqliteMigrationResult[] = [];
  const skipped: string[] = [];
  for (const source of selectSources(options.sourceId)) {
    // Connector stores run their own migrations when the store opens; the
    // registry this loop drives does not own them, so a connector-store-only
    // family has nothing to migrate here.
    //
    // A declared `sqlitePath` is NOT an invitation into this loop either. The
    // legacy per-family indexes are custody artifacts that export preserves
    // and delete removes; the live ones sit at their own retired schema
    // versions under retired store ids, so migrating them would write this
    // build's migrations into a schema it does not own — or refuse outright
    // on the version check — for files nothing reads. Only a family that
    // declares its own migration set is migrated here.
    const migrations = source.sqliteMigrations?.();
    if (!migrations) continue;
    const path = source.sqlitePath?.(options);
    if (!path) continue;
    if (!existsSync(path)) {
      skipped.push(path);
      continue;
    }
    // bun:sqlite requires SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE, so
    // `{ readwrite: false, create: false }` was rejected at open and every
    // dry run threw before reading a single store. A dry run reads the
    // schema_version table and nothing else, so open it readonly.
    const db = options.dryRun === true
      ? new Database(path, { readonly: true })
      : new Database(path, { readwrite: true, create: false });
    db.exec('PRAGMA busy_timeout = 10000;');
    try {
      stores.push(runSqliteMigrations(db, source.sqliteStoreId, migrations, { dryRun: options.dryRun }));
    } finally {
      closeSqliteStore(db);
    }
  }
  return { ok: true, dryRun: options.dryRun, stores, skipped };
}

export function validateDeleteAllConfirmations(first: string, second: string): void {
  if (first !== DELETE_CONFIRMATION_1 || second !== DELETE_CONFIRMATION_2) {
    throw new OperationError(
      'invalid_params',
      'delete --all requires both confirmation phrases.',
      `Type "${DELETE_CONFIRMATION_1}" and then "${DELETE_CONFIRMATION_2}", or use --yes-i-am-sure in automated tests.`,
    );
  }
}

export function deleteAllConfirmationPrompts(): { first: string; second: string } {
  return { first: DELETE_CONFIRMATION_1, second: DELETE_CONFIRMATION_2 };
}

export function knownOlympusDataRoots(context: LifecyclePathContext = {}): string[] {
  return olympusDataRoots({ homeDir: resolveHome(context.homeDir) });
}

function allDeleteTargets(context: LifecyclePathContext): DeleteTarget[] {
  const home = resolveHome(context.homeDir);
  return [
    ...selectSources(undefined).flatMap((source) => sourceDeleteTargets(source, context)),
    // Approved remote-agent connections. Removing the database revokes every
    // connection token at once. Named on its own because an explicit
    // OLYMPUS_REMOTE_CONNECTIONS_DB_PATH or XDG_DATA_HOME can put it outside
    // the known roots below.
    ...remoteConnectionsDeleteTargets(context),
    // Prepared photo copies (docs/design/photo-embeddings.md). Named on its
    // own because OLYMPUS_MEDIA_CACHE_DIR or XDG_DATA_HOME can put it outside
    // the known roots; it is always a directory Olympus created for itself.
    ...mediaCacheDeleteTargets(context),
    ...knownOlympusDataRoots(context).map((path): DeleteTarget => ({
      path,
      kind: 'known_root',
      allowRecursive: true,
    })),
    serviceUnitTarget(workerServicePaths('darwin', home).unitPath),
    serviceUnitTarget(workerServicePaths('linux', home).unitPath),
    ...globExisting(join(home, 'Library', 'LaunchAgents'), /^(?:(?:com|org)\.openclaw\.olympus.*|ai\.olympusplugin\.engine)\.plist$/)
      .map(serviceUnitTarget),
    ...globExisting(join(home, '.config', 'systemd', 'user'), /^olympus.*\.(service|timer)$/)
      .map(serviceUnitTarget),
  ];
}

function mediaCacheDeleteTargets(context: LifecyclePathContext): DeleteTarget[] {
  try {
    return [{ path: mediaCacheDir(envForContext(context)), kind: 'known_root', allowRecursive: true }];
  } catch {
    return [];
  }
}

/**
 * Releases the media-cache copies the given connector stores reference (the
 * store's own reference marker, as LocalConnectorStore holds it: named by the
 * store's real path, whatever spelling of it this process was given) and
 * returns the copies removed, or those a dry run would release. A path is
 * checked to be a media-cache file by its shape, not against this process's
 * configured cache directory, which may differ from the worker's.
 *
 * Every store is read before anything is deleted or released: a store that
 * cannot be read stops the delete with every marker still in place.
 */
type SourceMediaHolds = Array<{
  storePath: string;
  holder: string;
  rows: Array<{ media_path: string; media_sha256: string }>;
}>;

function readSourceMedia(storePaths: readonly string[]): SourceMediaHolds {
  const held: SourceMediaHolds = [];
  for (const storePath of storePaths) {
    if (storePath === ':memory:' || !existsSync(storePath)) continue;
    // A file that is not SQLite at all holds no references. One that is, and
    // cannot be read (corrupt, locked past the timeout), stops the delete:
    // deleting it would orphan its pictures' markers, so the sweep would
    // never remove those Private copies.
    if (!looksLikeSqlite(storePath)) continue;
    const unreadable = () => new OperationError(
      'invalid_params',
      `Cannot read the picture references in ${storePath}; nothing was deleted.`,
      'Stop the Olympus worker (olympus worker stop) so the store is not busy, or repair the store, then retry.',
    );
    let rows: Array<{ media_path: string; media_sha256: string }> = [];
    let db: Database;
    try {
      db = new Database(storePath, { readonly: true });
      db.exec('PRAGMA busy_timeout = 10000;');
    } catch {
      throw unreadable();
    }
    try {
      const columns = (db.query('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((column) => column.name);
      if (columns.includes('media_sha256')) {
        rows = db.query(`
          SELECT DISTINCT media_path, media_sha256 FROM chunks
          WHERE media_path IS NOT NULL AND media_sha256 IS NOT NULL
        `).all() as Array<{ media_path: string; media_sha256: string }>;
      }
    } catch {
      throw unreadable();
    } finally {
      closeSqliteStore(db);
    }
    // Named now, while the store exists: its real path is its marker's name,
    // and a deleted file has none.
    held.push({ storePath, holder: mediaHolderName(storePath), rows });
  }
  return held;
}

function releaseSourceMedia(held: SourceMediaHolds, dryRun: boolean): string[] {
  const released: string[] = [];
  for (const { storePath, holder, rows } of held) {
    for (const row of rows) {
      if (!isMediaCachePath(row.media_path, row.media_sha256)) continue;
      if (dryRun) {
        if (existsSync(row.media_path)) released.push(row.media_path);
      } else {
        // Under its real path, and under the path as given for a marker an
        // earlier build named by its spelling.
        const removedByHolder = releaseMediaCacheFile(row.media_path, row.media_sha256, holder);
        const removedBySpelling = holder !== storePath
          && releaseMediaCacheFile(row.media_path, row.media_sha256, storePath);
        if (removedByHolder || removedBySpelling) released.push(row.media_path);
      }
    }
  }
  return released;
}

function looksLikeSqlite(path: string): boolean {
  try {
    const fd = openSync(path, 'r');
    try {
      const header = Buffer.alloc(16);
      const read = readSync(fd, header, 0, 16, 0);
      return read === 16 && header.toString('latin1') === 'SQLite format 3\u0000';
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function sourceDeleteTargets(source: LifecycleSourceSpec, context: LifecyclePathContext): DeleteTarget[] {
  const legacyIndexPath = source.sqlitePath?.(context);
  return [
    ...(legacyIndexPath ? sqliteDeleteTargets(legacyIndexPath, legacyStoreIdFor(source), context) : []),
    ...(source.connectorStorePaths?.(context) ?? []).flatMap((storePath) => [
      ...sqliteDeleteTargets(storePath, CONNECTOR_STORE_SQLITE_STORE_ID, context),
      // Each store's four-tier ledger is co-located with it (tier-ledger-path.ts),
      // so it is found wherever the store is — a *_DB_PATH override, XDG, the
      // WhatsApp state directory — and deleting a source takes its ledger rows.
      ...(storePath === ':memory:'
        ? []
        : sqliteDeleteTargets(tierLedgerPathForStore(storePath), TIER_LEDGER_SQLITE_STORE_ID, context)),
      // A tiered store set keeps its secret-locations index (location only:
      // identity, locator, a scanned title, finding kinds) beside its
      // secure_local store, like the set ledger, so it goes with its source.
      ...(storePath === ':memory:'
        ? []
        : sqliteDeleteTargets(secretLocationsPathForStore(storePath), SECRET_LOCATIONS_SQLITE_STORE_ID, context)),
      // The sniffer's verdict cache and question queue sit beside it too; the
      // queue holds names and short excerpts, so it goes with the source.
      ...(storePath === ':memory:'
        ? []
        : sqliteDeleteTargets(tierSnifferPathForStore(storePath), TIER_SNIFFER_SQLITE_STORE_ID, context)),
    ]),
    ...(source.accountStateSqlite?.(context) ?? []).flatMap((state) => state.path === ':memory:'
      ? []
      : sqliteDeleteTargets(state.path, state.sqliteStoreId, context)),
    ...(source.rawStatePaths?.(context) ?? []).map((path): DeleteTarget => ({
      path,
      kind: 'source_state_path',
      // Spool and media are directories; the sole point of naming them is to
      // take the message history inside them.
      allowRecursive: true,
      externalSourcePath: !isInsideKnownOlympusRoot(path, context),
    })),
    ...(source.policyPaths?.(context) ?? []).map((path): DeleteTarget => ({
      path,
      kind: 'policy_file',
      allowRecursive: false,
    })),
  ];
}

/**
 * The connection database, its sidecars, and its pre-migration backup; and
 * the waiting private questions beside it (core/waiting-private-questions.ts),
 * which name those connections.
 */
function remoteConnectionsDeleteTargets(context: LifecyclePathContext): DeleteTarget[] {
  const dbPath = resolveRemoteConnectionsDbPath(envForContext(context));
  const targets = sqliteDeleteTargets(dbPath, REMOTE_CONNECTIONS_STORE_ID, context);
  return [
    ...targets,
    { ...targets[1]!, path: remoteConnectionsPreV2BackupPath(dbPath) },
    ...sqliteDeleteTargets(waitingPrivateQuestionsDbPath(dbPath), WAITING_PRIVATE_QUESTIONS_STORE_ID, context),
  ];
}

function sqliteDeleteTargets(
  sqlitePath: string,
  sqliteStoreId: string,
  context: LifecyclePathContext,
): DeleteTarget[] {
  const externalSourcePath = !isInsideKnownOlympusRoot(sqlitePath, context);
  return [
    {
      path: sqlitePath,
      kind: 'source_sqlite',
      sqliteStoreId,
      sqlitePrimaryPath: sqlitePath,
      allowRecursive: false,
      externalSourcePath,
    },
    {
      path: `${sqlitePath}-wal`,
      kind: 'source_sqlite_sidecar',
      sqliteStoreId,
      sqlitePrimaryPath: sqlitePath,
      allowRecursive: false,
      externalSourcePath,
    },
    {
      path: `${sqlitePath}-shm`,
      kind: 'source_sqlite_sidecar',
      sqliteStoreId,
      sqlitePrimaryPath: sqlitePath,
      allowRecursive: false,
      externalSourcePath,
    },
  ];
}

/**
 * A legacy index carries its own retired marker, so falling back to the
 * family's connector-store id would make the manifest and the external-path
 * fence assert a store the file is not. The fallback exists only so a spec
 * that declares a path without its marker fails a schema check instead of
 * silently claiming `connector-store`; a lifecycle test pins the pairing.
 */
function legacyStoreIdFor(source: LifecycleSourceSpec): string {
  return source.legacySqliteStoreId ?? source.sqliteStoreId;
}

function selectSources(sourceId: string | undefined): LifecycleSourceSpec[] {
  if (!sourceId) return lifecycleSourceSpecs();
  return [requireSource(sourceId)];
}

function requireSource(sourceId: string | undefined): LifecycleSourceSpec {
  const normalized = requirePath(sourceId, '--source');
  const source = lifecycleSourceSpecs().find(
    (entry) => entry.sourceId === normalized || entry.sourceAliases?.includes(normalized),
  );
  if (!source) {
    throw new OperationError(
      'invalid_params',
      `Unknown Olympus source id "${normalized}".`,
      `Use one of: ${lifecycleSourceSpecs().map((entry) => entry.sourceId).join(', ')}.`,
    );
  }
  return source;
}

/**
 * Exports one SQLite store as a verified, crash-durable snapshot.
 *
 * A file copy of the main database plus its sidecars is not a snapshot. A
 * checkpoint running between the two copies installs already-committed pages
 * into the live main file and resets the WAL, so the exported pair can omit a
 * transaction that committed BEFORE the export started — and the manifest
 * still reports success. `VACUUM INTO` asks SQLite for the snapshot instead:
 * one consolidated file produced under a read transaction, with the WAL folded
 * in rather than raced. The sidecars therefore have nothing left to carry.
 *
 * A declared store that exists but is not a readable SQLite database fails
 * closed. A byte copy of corrupt or encrypted bytes is not a verified
 * preservation snapshot and must not be reported as one.
 */
function exportSqliteStore(options: {
  sqlitePath: string;
  destinationRoot: string;
  exportRoot: string;
  sourceId: string;
  role: 'legacy_store' | 'connector_store';
  expectedStoreId: string;
  files: string[];
  skipped: string[];
  artifacts: DataExportArtifact[];
}): void {
  const { sqlitePath, destinationRoot, exportRoot, sourceId, role, expectedStoreId, files, skipped, artifacts } = options;
  if (!existsSync(sqlitePath)) {
    for (const path of sqliteWithSidecars(sqlitePath)) skipped.push(path);
    return;
  }
  const destination = join(destinationRoot, basename(sqlitePath));
  const staging = `${destination}.${randomUUID()}.partial`;
  if (snapshotSqliteStore(sqlitePath, staging)) {
    let sqlite: NonNullable<DataExportArtifact['sqlite']>;
    try {
      sqlite = inspectSqliteSnapshot(staging, sqlitePath, expectedStoreId);
      syncFileSync(staging);
      renameSync(staging, destination);
    } catch (error) {
      rmSync(staging, { force: true });
      throw error;
    }
    syncDirectorySync(dirname(destination));
    files.push(destination);
    artifacts.push({
      ...fileArtifact(exportRoot, destination, sourceId, role),
      sqlite,
    });
    return;
  }
  throw new OperationError(
    'source_index_error',
    `Declared Olympus SQLite store is not a readable database: ${sqlitePath}`,
    'The export failed closed; repair or explicitly account for the store before transition.',
  );
}

/**
 * Returns false — leaving nothing behind — when the path is not a database
 * SQLite can snapshot. Every other failure is a durability failure and reaches
 * the caller.
 */
function snapshotSqliteStore(sqlitePath: string, staging: string): boolean {
  rmSync(staging, { force: true });
  let db: Database;
  try {
    db = new Database(sqlitePath, { readonly: true });
  } catch {
    return false;
  }
  try {
    db.exec('PRAGMA busy_timeout = 10000;');
    db.exec(`VACUUM INTO '${sqliteStringLiteral(staging)}'`);
  } catch (error) {
    rmSync(staging, { force: true });
    if (isUnreadableSqliteError(error)) return false;
    throw new OperationError(
      'source_index_error',
      `Failed to snapshot Olympus SQLite store for export: ${sqlitePath}`,
      'Retry the export once the store is readable; no partial snapshot was published.',
    );
  } finally {
    closeSqliteStore(db);
  }
  return true;
}

function assertSqliteSnapshotIntact(snapshotPath: string, sqlitePath: string): void {
  inspectSqliteSnapshot(snapshotPath, sqlitePath, 'unknown');
}

function inspectSqliteSnapshot(
  snapshotPath: string,
  sqlitePath: string,
  expectedStoreId: string,
): NonNullable<DataExportArtifact['sqlite']> {
  const db = new Database(snapshotPath, { readonly: true });
  try {
    // busy_timeout leads, before the integrity check takes a read lock. The
    // staging snapshot is ours alone, but the rule is the connection's, not the
    // file's: an open with no timeout fails instantly on any contention it does
    // meet, and one exempt open is what licenses the next.
    db.exec('PRAGMA busy_timeout = 10000;');
    const rows = db.query('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      throw new OperationError(
        'source_index_error',
        `Olympus SQLite export snapshot failed its integrity check: ${sqlitePath}`,
        'The snapshot was discarded rather than published; retry the export.',
      );
    }
    const foreignKeyRows = db.query('PRAGMA foreign_key_check').all();
    if (foreignKeyRows.length > 0) {
      throw new OperationError(
        'source_index_error',
        `Olympus SQLite export snapshot failed its foreign-key check: ${sqlitePath}`,
        'The snapshot was discarded rather than published; repair the store before transition.',
      );
    }
    const schemaVersion = expectedStoreId === 'unknown' ? 0 : readSqliteSchemaVersion(db, expectedStoreId);
    return {
      integrityCheck: 'ok',
      foreignKeyViolations: foreignKeyRows.length,
      expectedStoreId,
      schemaVersion,
    };
  } finally {
    closeSqliteStore(db);
  }
}

function fileArtifact(
  exportRoot: string,
  path: string,
  sourceId: string,
  role: DataExportArtifact['role'],
): DataExportArtifact {
  const stats = statSync(path);
  return {
    sourceId,
    role,
    relativePath: relative(resolve(exportRoot), resolve(path)),
    bytes: stats.size,
    sha256: sha256File(path),
  };
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function parseExportArtifact(value: unknown): DataExportArtifact {
  if (!value || typeof value !== 'object') {
    throw new OperationError('source_index_error', 'Olympus data export manifest contains an invalid artifact.');
  }
  const artifact = value as Partial<DataExportArtifact>;
  if (typeof artifact.relativePath !== 'string'
    || artifact.relativePath.length === 0
    || typeof artifact.bytes !== 'number'
    || !Number.isSafeInteger(artifact.bytes)
    || artifact.bytes < 0
    || typeof artifact.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new OperationError('source_index_error', 'Olympus data export manifest contains an invalid artifact.');
  }
  return artifact as DataExportArtifact;
}

/**
 * `VACUUM INTO` takes an SQL string literal, not a bound parameter, so the one
 * character that can end it is doubled. The path is Olympus-derived rather
 * than attacker-supplied, but a destination directory with an apostrophe in it
 * would otherwise produce a syntax error at export time.
 */
function sqliteStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function isUnreadableSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('not a database') || message.includes('file is encrypted');
}

function sqliteWithSidecars(sqlitePath: string): string[] {
  return [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`];
}

function copySanitizedJsonIfPresent(source: string, destination: string, files: string[], skipped: string[]): boolean {
  if (!existsSync(source)) {
    skipped.push(source);
    return false;
  }
  const parsed = JSON.parse(readFileSync(source, 'utf8')) as unknown;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(destination, JSON.stringify(sanitizeForExport(parsed), null, 2));
  files.push(destination);
  return true;
}

/**
 * The deepest directory the export will NOT create, which is where the fsync
 * walk has to stop.
 *
 * `mkdir -p` creates grandparents too. Stopping at the destination's parent
 * flushed that parent but never the directory holding ITS entry, so a
 * first-time or dated backup target — `--output ~/exports/olympus/2026-08-18`
 * with `~/exports/olympus` absent — fsynced every snapshot and the manifest
 * into a chain whose top link had never reached the disk. A power loss then
 * took the whole export, which is the one outcome the fsyncs below exist to
 * prevent. Exported because the boundary is not observable from the exported
 * tree; a test pins it.
 */
export function exportDurabilityBoundary(destination: string): string {
  let current = dirname(resolve(destination));
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Creates a directory chain and flushes every level of it, up to and including
 * `boundary`. A file that was fsynced into a directory whose own entry never
 * reached the disk is still gone after a power loss, so the export's
 * directories are made durable before anything is written into them.
 */
function makeDurableDirectory(path: string, boundary: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  let current = resolve(path);
  for (;;) {
    syncDirectorySync(current);
    if (current === boundary) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function syncFileSync(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectorySync(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    closeSync(descriptor);
  }
}

function sanitizeForExport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForExport);
  if (typeof value === 'string' && containsPrivateKeyBlock(value)) return '[redacted_secret]';
  if (!value || typeof value !== 'object') return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    sanitized[key] = sanitizeForExport(child);
  }
  return sanitized;
}

function isSecretKey(key: string): boolean {
  if (key === 'secretRef') return false;
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'secret'
    || normalized === 'token'
    || normalized === 'authtoken'
    || normalized === 'accesstoken'
    || normalized === 'refreshtoken'
    || normalized === 'apikey'
    || normalized === 'clientsecret'
    || normalized === 'password'
    || normalized === 'privatekey'
    || normalized === 'serviceaccountjson'
    || normalized === 'credential'
    || normalized === 'credentials') {
    return true;
  }
  const lowered = key.toLowerCase();
  return lowered === 'secret'
    || lowered.includes('authtoken')
    || lowered.includes('access_token')
    || lowered.includes('refreshtoken')
    || lowered.includes('refresh_token')
    || lowered.includes('apikey')
    || lowered.includes('api_key')
    || lowered.includes('clientsecret')
    || lowered.includes('client_secret')
    || lowered.includes('password')
    || lowered === 'token';
}

function containsPrivateKeyBlock(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

function globExisting(root: string, pattern: RegExp): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((path) => {
      const name = basename(path);
      return pattern.test(name) && statSync(path).isFile();
    });
}

function serviceUnitTarget(path: string): DeleteTarget {
  return {
    path,
    kind: 'service_unit',
    allowRecursive: false,
  };
}

/**
 * Check every existing target. An external SQLite file family is normally
 * proven ours by opening its primary store. Once the primary has been removed
 * (the delete removes it first), a surviving sidecar can no longer be proven
 * that way, so the ownership the earlier, successful check recorded
 * (`priorVerifiedPrimaries`) carries the cleanup to the end. Returns the
 * primaries proven now, for the caller to record.
 */
const RELOCATING_ENV_NAME = /^OLYMPUS_[A-Z0-9_]*(_PATH|_DB|_CONFIG|_FILE|_DIR|_ROOT)$/;

/**
 * A database target that is not where its source keeps it by default (some
 * override moved it, even to a spot inside an Olympus root) is only the
 * source's own if its contents say so: it gets the same ownership/schema
 * validation as one outside every root.
 */
function markRelocatedStores(targets: DeleteTarget[], context: LifecyclePathContext): DeleteTarget[] {
  const env = envForContext(context);
  const scrubbed: Record<string, string | undefined> = { ...env };
  for (const name of Object.keys(scrubbed)) if (RELOCATING_ENV_NAME.test(name)) scrubbed[name] = undefined;
  const defaults = new Set<string>();
  for (const spec of lifecycleSourceSpecs()) {
    try {
      for (const target of sourceDeleteTargets(spec, { ...context, env: scrubbed })) {
        if (target.sqliteStoreId) defaults.add(canonicalPath(target.sqlitePrimaryPath ?? target.path));
      }
    } catch { /* an unresolvable default marks nothing as default */ }
  }
  return targets.map((target) => target.sqliteStoreId
    && target.externalSourcePath !== true
    && !defaults.has(canonicalPath(target.sqlitePrimaryPath ?? target.path))
    ? { ...target, externalSourcePath: true }
    : target);
}

function assertTargetsSafe(targets: readonly DeleteTarget[], priorVerifiedPrimaries: readonly string[] = []): string[] {
  const prior = new Set(priorVerifiedPrimaries.map((path) => resolve(path)));
  const verified = new Set<string>();
  for (const target of targets) {
    if (!existsSync(target.path)) continue;
    const primary = target.externalSourcePath === true && target.kind !== 'source_state_path' && target.kind !== 'known_root'
      ? resolve(target.sqlitePrimaryPath ?? target.path)
      : undefined;
    if (primary && !existsSync(primary) && prior.has(primary)) {
      assertRegularFileTarget(target.path);
      continue;
    }
    assertDeleteTargetSafe(target);
    if (primary) verified.add(primary);
  }
  return [...verified].sort();
}

function assertDeleteTargetSafe(target: DeleteTarget): void {
  if (target.kind === 'source_state_path') {
    // Raw state carries no Olympus schema marker to verify, so a state
    // directory an operator has pointed outside every Olympus root cannot be
    // proven ours. Refusing before anything is removed is the only honest
    // answer: a recursive delete of a stranger's directory is unrecoverable,
    // and a silent skip is the false completion this target exists to end.
    if (target.externalSourcePath === true) {
      throw new OperationError(
        'invalid_params',
        `Refusing to delete source state outside an Olympus-owned root: ${target.path}`,
        'Check the configured state-directory value (OLYMPUS_WHATSAPP_STATE_DIR and its spool/media overrides), then remove that directory by hand.',
      );
    }
    return;
  }

  if (target.kind === 'known_root') {
    if (!lstatSync(target.path).isDirectory()) {
      throw new OperationError(
        'invalid_params',
        `Refusing to recursively delete non-directory Olympus root: ${target.path}`,
      );
    }
    return;
  }

  assertRegularFileTarget(target.path);
  if (target.externalSourcePath === true) {
    const primaryPath = target.sqlitePrimaryPath ?? target.path;
    assertVerifiedExternalSqliteStore(primaryPath, target.sqliteStoreId);
  }
}

function assertRegularFileTarget(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new OperationError(
      'invalid_params',
      `Refusing to delete non-file target outside an Olympus-owned root: ${path}`,
    );
  }
}

function assertVerifiedExternalSqliteStore(path: string, storeId: string | undefined): void {
  if (!storeId) {
    throw new OperationError('invalid_params', `Refusing to delete external SQLite path without a store id: ${path}`);
  }
  assertRegularFileTarget(path);
  let db: Database;
  try {
    db = new Database(path, { readonly: true, create: false });
    db.exec('PRAGMA busy_timeout = 10000;');
  } catch {
    throw new OperationError(
      'invalid_params',
      `Refusing to delete external source path that is not a readable Olympus SQLite store: ${path}`,
      'Check the configured OLYMPUS_*_DB_PATH value before retrying data deletion.',
    );
  }
  try {
    let schemaVersion = 0;
    try {
      schemaVersion = readSqliteSchemaVersion(db, storeId);
    } catch {
      throw new OperationError(
        'invalid_params',
        `Refusing to delete external source path that is not a readable Olympus SQLite store: ${path}`,
        'Check the configured OLYMPUS_*_DB_PATH value before retrying data deletion.',
      );
    }
    if (schemaVersion <= 0) {
      throw new OperationError(
        'invalid_params',
        `Refusing to delete external SQLite store without Olympus schema marker "${storeId}": ${path}`,
        'Run data delete only after confirming the configured path belongs to Olympus.',
      );
    }
  } finally {
    closeSqliteStore(db);
  }
}

/** Nearest existing ancestor's real path plus the not-yet-existing remainder. */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

function isStrictlyInside(path: string, root: string): boolean {
  return path !== root && path.startsWith(`${root}${sep}`);
}

/**
 * The safety rules for a RECURSIVE raw-state delete target (spool, media,
 * gateway state: whatever an env override or a default names).
 *
 * 1. Strictly inside an Olympus root, never equal to one and never above one: an
 *    override such as OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR=~/.local/share/olympus
 *    would otherwise turn one source's delete into every source's.
 * 2. No symlink anywhere between the root and the target, the target itself
 *    included: the real path must equal the lexical path under the root's real
 *    path. A symlinked raw directory would otherwise send a recursive delete
 *    into whatever it points at. We REFUSE rather than delete only the link,
 *    because a link there means the owner pointed Olympus at storage it may
 *    not own, and silently removing the link would still report a delete that
 *    left the data in place.
 * 3. (One source's delete) it must not equal, contain or sit inside any other
 *    source's delete target, any login or pairing path, or the shared config,
 *    registry, connections and media-cache paths.
 * Symlinks NESTED inside a valid target are not followed: rmSync unlinks them
 * (pinned by a test), so what they point at survives.
 * Refusing happens before anything is removed.
 */
function assertRawStateTargetsContained(
  targets: readonly DeleteTarget[],
  context: LifecyclePathContext,
  selectedSource: LifecycleSourceSpec | undefined,
): void {
  const stateTargets = targets.filter((target) => target.kind === 'source_state_path' && target.allowRecursive);
  // The store-custody lock must outlive every delete: a target that is, or
  // contains, it would let the next opener lock a fresh file.
  const custodyHome = resolveHome(context.homeDir);
  const custodyLocks = [...new Set([
    storeCustodyLockPath(custodyHome),
    canonicalPath(storeCustodyLockPath(custodyHome)),
    // The lock folder's own real place, should anything have made it a link.
    join(canonicalPath(storeCustodyDirectory(custodyHome)), 'store-lifecycle.lock.db'),
  ])];
  for (const target of targets) {
    for (const candidate of [resolve(target.path), canonicalPath(target.path)]) {
      if (custodyLocks.some((custodyLock) => candidate === custodyLock || isStrictlyInside(custodyLock, candidate))) {
        throw new OperationError(
          'invalid_params',
          `Refusing to delete ${target.path}: it holds the lock that keeps Olympus stores safe while they are deleted.`,
          'Check the configured paths. Nothing was deleted.',
        );
      }
    }
  }
  const roots = knownOlympusDataRoots(context).map((root) => ({ lexical: resolve(root), real: canonicalPath(root) }));
  const refuse = (path: string, why: string): never => {
    throw new OperationError(
      'invalid_params',
      `Refusing to delete source state ${why}: ${path}`,
      'Check the configured state-directory values, then remove that directory by hand. Nothing was deleted.',
    );
  };
  // Every file-like target too (stores, sidecars, policy files): a symbolic
  // link in or above it must not lead the unlink somewhere else.
  const fileTargets = targets.filter((target) => target.kind === 'source_sqlite'
    || target.kind === 'source_sqlite_sidecar' || target.kind === 'policy_file');
  for (const target of fileTargets) {
    const lexical = resolve(target.path);
    const root = roots.find((candidate) => isStrictlyInside(lexical, candidate.lexical));
    if (!root) continue;
    const expectedReal = join(root.real, relative(root.lexical, lexical));
    if (canonicalPath(lexical) !== expectedReal) refuse(target.path, 'because it, or a directory above it, is a symbolic link');
  }
  for (const target of stateTargets) {
    const lexical = resolve(target.path);
    const root = roots.find((candidate) => isStrictlyInside(lexical, candidate.lexical));
    if (!root) {
      // Equal to a root, above one, or outside all of them. Outside is the
      // external fence's job (it names the override); equal or above is ours.
      if (roots.some((candidate) => lexical === candidate.lexical || isStrictlyInside(candidate.lexical, lexical))) {
        refuse(target.path, 'that is, or contains, an Olympus data root');
      }
      continue;
    }
    const expectedReal = join(root.real, relative(root.lexical, lexical));
    if (canonicalPath(lexical) !== expectedReal) refuse(target.path, 'because it, or a directory above it, is a symbolic link');
  }
  if (!selectedSource) return;
  const own = new Set([selectedSource.sourceId, ...(selectedSource.sourceAliases ?? [])]);
  // Authoritative state (config, registry, secrets, shared stores) is protected
  // unconditionally. A swept override is exempt only when the selected source
  // itself reads that variable: removing it from the environment changes this
  // source's own delete targets, so the path is provably its own.
  const protectedPaths = new Set<string>(authoritativeStatePaths(context));
  for (const override of sweptPathOverrides(context)) {
    const withoutVar = { ...context, env: { ...envForContext(context), [override.name]: undefined } };
    let ownsIt = false;
    try {
      const before = new Set(sourceDeleteTargets(selectedSource, withoutVar).map((target) => resolve(target.path)));
      const after = new Set(sourceDeleteTargets(selectedSource, context).map((target) => resolve(target.path)));
      ownsIt = after.has(override.path) && !before.has(override.path);
    } catch { /* cannot prove it is the source's own: stays protected */ }
    if (!ownsIt) protectedPaths.add(override.path);
  }
  for (const other of lifecycleSourceSpecs()) {
    if (own.has(other.sourceId)) continue;
    for (const path of sourceDeleteTargets(other, context).map((target) => target.path)) protectedPaths.add(path);
    for (const path of other.preservationOnlyPaths?.(context) ?? []) protectedPaths.add(path);
    for (const path of other.pairingSessionPaths?.(context) ?? []) protectedPaths.add(path);
  }
  for (const path of selectedSource.preservationOnlyPaths?.(context) ?? []) protectedPaths.add(path);
  const protectedCanonical = withSqliteSidecars(protectedPaths).flatMap((path) => [resolve(path), canonicalPath(path)]);
  // Every target, whatever its kind: a relocated index or policy file is just
  // as able to point at the owner's config as a state directory is.
  for (const target of targets) {
    const candidates = [resolve(target.path), canonicalPath(target.path)];
    for (const protectedPath of protectedCanonical) {
      for (const candidate of candidates) {
        if (candidate === protectedPath || isStrictlyInside(protectedPath, candidate) || isStrictlyInside(candidate, protectedPath)) {
          // A target legitimately inside its OWN source's other path is not
          // reachable here: own paths are not in the protected set.
          refuse(target.path, `because it overlaps another source's or shared Olympus data (${protectedPath})`);
        }
      }
    }
  }
}

/**
 * The files Olympus cannot run without, resolved the way the running engine
 * resolves them, overrides applied: the credential handle registry and every
 * record and lock beside it, the this-computer and unpaired records, the
 * owner config, the secret store and its key, the remote-connections store and
 * the media cache. A recursive raw-state delete must never reach any of them,
 * whatever directory an override points it at. Both the configured and the
 * default locations are named, since either may be the live one.
 */
function authoritativeStatePaths(context: LifecyclePathContext): string[] {
  const home = resolveHome(context.homeDir);
  const env = envForContext(context);
  const registries = new Set<string>([join(home, '.config', 'olympus', 'handles.json')]);
  const configuredRegistry = env.OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH?.trim();
  if (configuredRegistry) registries.add(resolve(configuredRegistry));
  if (context.registryPath?.trim()) registries.add(resolve(context.registryPath));
  const files = new Set<string>();
  for (const registry of registries) {
    const dir = dirname(registry);
    for (const path of [
      registry,
      `${registry}.grant-custody`,
      `${registry}.grant-epoch.json`,
      `${registry}.unpaired`,
      join(dir, 'this-computer.json'),
      join(dir, 'source-account-bindings.json'),
      join(dir, 'mail-source-scopes.json'),
      join(dir, 'file-source-scopes.json'),
      join(dir, 'messaging-capture.telegram.json'),
      join(dir, 'messaging-capture.whatsapp.json'),
      join(dir, 'pending-source-deletes.json'),
    ]) {
      files.add(path);
      files.add(`${path}.lock`);
    }
  }
  const configDirs = new Set<string>([join(home, '.config', 'olympus')]);
  try { configDirs.add(defaultOlympusConfigDir(env)); } catch { /* an unresolvable layout adds nothing */ }
  for (const dir of configDirs) {
    for (const name of ['secrets.enc', 'secrets.key', 'secret-backend.json']) files.add(join(dir, name));
  }
  try {
    for (const path of Object.values(resolveLinuxSecretPaths(env))) files.add(path);
  } catch { /* not a Linux layout */ }
  const configured = (name: string) => {
    const value = env[name]?.trim();
    return value ? [resolve(value)] : [];
  };
  for (const path of [
    join(home, '.olympus', 'config.json'),
    ...configured('OLYMPUS_CONFIG'),
    ...configured('OLYMPUS_SOVEREIGNTY_CONFIG'),
    ...configured('OLYMPUS_SOVEREIGNTY_CONFIG_PATH'),
    defaultFileExtractionJobsDbPath(env),
    ...authoritativeDefaultsFromConsumers(env),
    defaultSovereigntyConfigPathForHome(context.homeDir),
    defaultSovereigntyConfigPath(env),
    ...remoteConnectionsDeleteTargets(context).map((target) => target.path),
    ...mediaCacheDeleteTargets(context).map((target) => target.path),
  ]) files.add(path);
  return [...files];
}

/**
 * The one registry of shared authoritative files: each entry is a consumer's
 * own resolver, so the protected set cannot drift from where the consumer
 * really reads. A new authoritative resolver is added HERE; the test in
 * test/authoritative-files.test.ts fails when an exported default/resolve path
 * function exists that is neither listed here nor classified as something else.
 */
export const AUTHORITATIVE_FILE_RESOLVERS: ReadonlyArray<{ name: string; resolve: (env: Record<string, string | undefined>) => string }> = [
  { name: 'workerSetupEnvPath', resolve: (env) => workerSetupEnvPath({ env }) },
  { name: 'resolveEmbeddingLedgerPath', resolve: (env) => resolveEmbeddingLedgerPath(env) },
  { name: 'resolveClassificationLedgerPath', resolve: (env) => resolveClassificationLedgerPath(env) },
  { name: 'defaultSourceSchedulerStateDbPath', resolve: (env) => defaultSourceSchedulerStateDbPath(env) },
  { name: 'defaultSourceIngestionExclusionsPath', resolve: (env) => defaultSourceIngestionExclusionsPath(env) },
  { name: 'defaultPrivacyProfilePath', resolve: (env) => defaultPrivacyProfilePath(env) },
  { name: 'defaultTierRulesPath', resolve: (env) => defaultTierRulesPath(env) },
  { name: 'defaultXBookmarksApiUsageDbPath', resolve: (env) => defaultXBookmarksApiUsageDbPath(env) },
];

/**
 * The default location of every shared authoritative file, from the resolver
 * its consumer uses (not a copy of its layout), together with the file a
 * relocating variable points at. A source-path override aimed at one of them
 * is refused whatever the override variable's name is.
 */
function authoritativeDefaultsFromConsumers(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const entry of AUTHORITATIVE_FILE_RESOLVERS) {
    try {
      const path = resolve(entry.resolve(env));
      out.push(path, `${path}-wal`, `${path}-shm`, `${path}-journal`, `${path}.lock`, `${path}.lock.db`);
    } catch { /* an unresolvable layout adds nothing */ }
  }
  return out;
}

/**
 * Every other file or store a deployment relocates by an OLYMPUS_* path
 * variable (shared stores, ledgers, budget and broker state, drains), found by
 * variable NAME so none can be forgotten. A relative value is resolved the way
 * its consumer resolves it (against the working directory), so a relative
 * override cannot slip past the overlap check.
 */
function sweptPathOverrides(context: LifecyclePathContext): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  for (const [name, value] of Object.entries(envForContext(context))) {
    if (!SHARED_PATH_ENV_NAME.test(name) || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed === ':memory:' || trimmed.startsWith('{')) continue;
    out.push({ name, path: resolve(trimmed) });
  }
  return out;
}

const SQLITE_FILE = /\.(sqlite3?|db)$/;
function withSqliteSidecars(paths: Iterable<string>): string[] {
  const all = new Set<string>();
  for (const path of paths) {
    all.add(path);
    if (SQLITE_FILE.test(path)) for (const suffix of ['-wal', '-shm', '-journal']) all.add(`${path}${suffix}`);
  }
  return [...all];
}

/** Env variables that relocate a file or store: matched by name so none can be forgotten. */
const SHARED_PATH_ENV_NAME = /^OLYMPUS_[A-Z0-9_]*(_PATH|_DB|_CONFIG|_FILE)$/;

function isInsideKnownOlympusRoot(path: string, context: LifecyclePathContext): boolean {
  return knownOlympusDataRoots(context).some((root) => isSameOrInsidePath(path, root));
}

function isSameOrInsidePath(path: string, root: string): boolean {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(root);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${sep}`);
}

function defaultSovereigntyConfigPathForHome(homeDir: string | undefined): string {
  if (!homeDir || process.platform === 'linux') return defaultSovereigntyConfigPath(envForHome(homeDir));
  return join(homeDir, '.olympus', 'sovereignty.json');
}

function defaultDropboxIngestionPolicyPathForHome(homeDir: string | undefined): string {
  if (!homeDir || process.platform === 'linux') return defaultDropboxIngestionPolicyPath(envForHome(homeDir));
  return join(homeDir, '.olympus', 'sources', 'dropbox.personal.ingestion.json');
}

function envForHome(homeDir: string | undefined): Record<string, string | undefined> {
  if (!homeDir) return process.env;
  return {
    HOME: homeDir,
    XDG_DATA_HOME: join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: join(homeDir, '.local', 'state'),
  };
}

function envForContext(context: LifecyclePathContext | undefined): Record<string, string | undefined> {
  if (!context?.env) return envForHome(context?.homeDir);
  if (!context.homeDir) return context.env;
  return { ...envForHome(context.homeDir), ...context.env };
}

function resolveHome(homeDir: string | undefined): string {
  return homeDir?.trim() || homedir();
}

function requirePath(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new OperationError('invalid_params', `${name} must be provided.`);
  return value.trim();
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function uniqueTargets(values: DeleteTarget[]): DeleteTarget[] {
  const byPath = new Map<string, DeleteTarget>();
  for (const value of values) {
    const existing = byPath.get(value.path);
    if (!existing || (existing.kind !== 'known_root' && value.kind === 'known_root')) {
      byPath.set(value.path, value);
    }
  }
  return [...byPath.values()];
}

export function relativeLifecyclePaths(paths: string[], root: string): string[] {
  return paths.map((path) => relative(root, path)).sort();
}
