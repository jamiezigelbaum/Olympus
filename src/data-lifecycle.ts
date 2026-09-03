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
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Database } from 'bun:sqlite';
import { isUnsupportedDirectorySyncError, writePrivateFileAtomicSync } from './core/atomic-file.ts';
import { OperationError } from './core/operation-error.ts';
import {
  readSqliteSchemaVersion,
  runSqliteMigrations,
  type SqliteMigration,
  type SqliteMigrationResult,
} from './core/sqlite-migrations.ts';
import { defaultDropboxIngestionPolicyPath } from './core/source-ingestion-policy.ts';
import { defaultDropboxConnectorStoreDbPath } from './workers/dropbox-files/index.ts';
import {
  defaultGmailConnectorStoreDbPath,
  defaultGmailSecureConnectorStoreDbPath,
  defaultGoogleDriveConnectorStoreDbPath,
  defaultGoogleDriveSecureConnectorStoreDbPath,
} from './workers/google-connectors/index.ts';
import {
  defaultInternalTelegramConnectorStoreDbPath,
  defaultProtectedTelegramConnectorStoreDbPath,
} from './workers/telegram-messages/index.ts';
import { defaultReadwiseConnectorStoreDbPath } from './workers/readwise/index.ts';
import { defaultXBookmarksConnectorStoreDbPath } from './workers/x-bookmarks/index.ts';
import { defaultWhatsAppConnectorStoreDbPath } from './workers/whatsapp/index.ts';
import { defaultSovereigntyConfigPath } from './core/sovereignty.ts';
import {
  olympusDataRoots,
  telegramPairingSessionPaths,
  whatsappPairingSessionPaths,
  whatsappStateDir as resolveWhatsAppStateDir,
} from './core/pairing-session-paths.ts';
import { V0_4_PUBLIC_SOURCE_CAPABILITIES } from './core/public-source-capabilities.ts';
import { workerServicePaths, type WorkerServiceState } from './core/worker-service.ts';
import { closeSqliteStore } from './core/sqlite-store.ts';
import type { ConnectedHandleRegistry } from './workers/credential-broker/connected-handles.ts';

export interface LifecyclePathContext {
  homeDir?: string;
  env?: Record<string, string | undefined>;
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
   * State that must be preserved before a source is stopped or removed, but
   * which the generic export intentionally does not copy. Unlike
   * `rawStatePaths`, these paths are inventory-only and are never added to a
   * delete command. This keeps preservation discovery from silently widening
   * a destructive surface.
   */
  preservationOnlyPaths?(context?: LifecyclePathContext): string[];
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
}

export interface DataDeleteCustody {
  requirement: 'source_disconnected' | 'worker_inactive';
  ready: boolean;
  observed: 'disconnected' | 'connected' | WorkerServiceState | 'unknown_registry';
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
      connectorStorePaths: (context) => [
        defaultGmailConnectorStoreDbPath(envForContext(context)),
        defaultGmailSecureConnectorStoreDbPath(envForContext(context)),
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
      connectorStorePaths: (context) => [defaultDropboxConnectorStoreDbPath(envForContext(context))],
      policyPaths: (context) => [defaultDropboxIngestionPolicyPathForHome(context?.homeDir)],
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
      preservationOnlyPaths: (context) => telegramPreservationOnlyPaths(envForContext(context)),
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
      connectorStorePaths: (context) => [defaultReadwiseConnectorStoreDbPath(envForContext(context))],
    },
    {
      // The legacy X bookmarks index was retired and deleted (2026-07-28), so
      // this family is connector-store only. It was absent from the inventory
      // entirely, which made its corpus unexportable by any command — and
      // invisible even in the manifest's `skipped` list.
      sourceId: 'x.bookmarks',
      label: 'X bookmarks connector store',
      sqliteStoreId: CONNECTOR_STORE_SQLITE_STORE_ID,
      connectorStorePaths: (context) => [defaultXBookmarksConnectorStoreDbPath(envForContext(context))],
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
      connectorStorePaths: (context) => [defaultWhatsAppConnectorStoreDbPath(envForContext(context))],
      rawStatePaths: (context) => whatsappRawStatePaths(envForContext(context)),
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
    env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'),
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

function telegramPreservationOnlyPaths(env: Record<string, string | undefined>): string[] {
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
  return [...new Set([
    spoolDir,
    cursorPath,
    gatewayStateDir,
    ...telegramPairingSessionPaths({ env }),
  ])];
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
    for (const statePath of source.preservationOnlyPaths?.(options) ?? []) skipped.push(statePath);
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

export function deleteOlympusData(options: {
  all?: boolean;
  sourceId?: string;
  dryRun?: boolean;
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
  const uniqueDeleteTargets = uniqueTargets(targets);
  for (const target of uniqueDeleteTargets) {
    if (existsSync(target.path)) assertDeleteTargetSafe(target);
  }
  for (const target of uniqueDeleteTargets) {
    if (!existsSync(target.path)) {
      missing.push(target.path);
      continue;
    }
    removed.push(target.path);
    if (options.dryRun !== true) {
      rmSync(target.path, { recursive: target.allowRecursive, force: true });
    }
  }

  return {
    ok: true,
    mode: options.all === true ? 'all' : 'source',
    ...(selectedSource ? { sourceId: selectedSource.sourceId } : {}),
    dryRun: options.dryRun === true,
    removed,
    missing,
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
  connectedRegistry?: ConnectedHandleRegistry;
  workerState?: WorkerServiceState;
} & LifecyclePathContext): DataDeleteWithCustodyResult {
  const custody = dataDeleteCustody(options);
  if (options.dryRun !== true && !custody.ready) {
    throw new OperationError(
      'invalid_params',
      custody.requirement === 'source_disconnected'
        ? `Disconnect ${options.sourceId} before deleting its local data.`
        : 'Stop or uninstall the Olympus worker before deleting local data.',
      custody.next_action,
    );
  }
  return {
    ...deleteOlympusData(options),
    custody,
  };
}

export function dataDeleteCustody(options: {
  all?: boolean;
  sourceId?: string;
  connectedRegistry?: ConnectedHandleRegistry;
  workerState?: WorkerServiceState;
}): DataDeleteCustody {
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
    const connected = options.connectedRegistry.handles.some(
      (handle) => handle.provider === publicCapability.doctor_lane.provider,
    );
    return connected
      ? {
          requirement: 'source_disconnected',
          ready: false,
          observed: 'connected',
          next_action: 'Use Disconnect in the local dashboard, then rerun the CLI delete.',
        }
      : {
          requirement: 'source_disconnected',
          ready: true,
          observed: 'disconnected',
        };
  }

  const workerState = options.workerState;
  const ready = workerState === 'inactive' || workerState === 'missing';
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
    ...knownOlympusDataRoots(context).map((path): DeleteTarget => ({
      path,
      kind: 'known_root',
      allowRecursive: true,
    })),
    serviceUnitTarget(workerServicePaths('darwin', home).unitPath),
    serviceUnitTarget(workerServicePaths('linux', home).unitPath),
    ...globExisting(join(home, 'Library', 'LaunchAgents'), /^(?:com|org)\.openclaw\.olympus.*\.plist$/)
      .map(serviceUnitTarget),
    ...globExisting(join(home, '.config', 'systemd', 'user'), /^olympus.*\.(service|timer)$/)
      .map(serviceUnitTarget),
  ];
}

function sourceDeleteTargets(source: LifecycleSourceSpec, context: LifecyclePathContext): DeleteTarget[] {
  const legacyIndexPath = source.sqlitePath?.(context);
  return [
    ...(legacyIndexPath ? sqliteDeleteTargets(legacyIndexPath, legacyStoreIdFor(source), context) : []),
    ...(source.connectorStorePaths?.(context) ?? []).flatMap((storePath) =>
      sqliteDeleteTargets(storePath, CONNECTOR_STORE_SQLITE_STORE_ID, context)),
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
  mkdirSync(dirname(destination), { recursive: true });
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
  mkdirSync(path, { recursive: true });
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

function isInsideKnownOlympusRoot(path: string, context: LifecyclePathContext): boolean {
  return knownOlympusDataRoots(context).some((root) => isSameOrInsidePath(path, root));
}

function isSameOrInsidePath(path: string, root: string): boolean {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(root);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${sep}`);
}

function defaultSovereigntyConfigPathForHome(homeDir: string | undefined): string {
  if (!homeDir) return defaultSovereigntyConfigPath();
  return join(homeDir, '.olympus', 'sovereignty.json');
}

function defaultDropboxIngestionPolicyPathForHome(homeDir: string | undefined): string {
  if (!homeDir) return defaultDropboxIngestionPolicyPath();
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
