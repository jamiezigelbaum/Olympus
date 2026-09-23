// Source-specific control plane around the real Google Drive SourceConnector.
// Provider I/O stays inside Contract 1; shared ingest and embedding stay in the
// generic connector-store runner. Everything that leaves this module is
// counts-only: the resume cursor is handed to the scheduler as an opaque
// checkpoint and never appears in a receipt, warning, or log line.
//
// The normal product lane is the Drive API under a resumable full traversal,
// then an incremental modifiedTime watermark, a durable day budget, and
// Retry-After handling. Existing history lives in the canonical stores;
// normal runtime has no migration source or fallback index.

import type { SensitivityMap } from '../../core/sensitivity-map.ts';
import { createHash } from 'node:crypto';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  sourceInvocationProvenance,
  type SourceInvocationProvenance,
} from '../../core/invocation-provenance.ts';
import {
  type ConnectorStoreEmbedSummary,
  type ConnectorStoreSyncSummary,
  type LocalConnectorStore,
} from '../connector-store/index.ts';
import {
  createLaneTieredStoreSet,
  type TieredStoreRoutingCounts,
  type TieredStoreSet,
  type TieredStoreSetRun,
} from '../connector-store/tiered-store-set.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import {
  isApprovedSecureSourceEmbeddingProvider,
  type SourceEmbeddingProvider,
} from '../source-index/embeddings.ts';
import { accountFromGoogleHandle, loadGoogleSensitivityMap } from './classification.ts';
import {
  DEFAULT_GOOGLE_DRIVE_CONTENT_MAX_FILES,
  GOOGLE_DRIVE_PROVIDER,
  GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID,
  GoogleDriveSourceConnector,
  googleDriveConnectorStoreClassification,
  isGoogleDriveConnectorCursor,
  type GoogleDriveSourceConnectorOptions,
} from './drive.ts';
import {
  defaultGoogleDriveLiveSyncConfig,
  type GoogleDriveLiveSyncConfig,
} from './drive-live-control.ts';
import type { GoogleDailyRequestBudget, GoogleRequestBudgetStatus } from './request-budget.ts';

export const GOOGLE_DRIVE_STORE_PULL_RECEIPT_KIND = 'google_drive_connector_store_pull_receipt';
export const GOOGLE_DRIVE_STORE_RECONCILE_RECEIPT_KIND =
  'google_drive_connector_store_reconcile_receipt';
export const GOOGLE_DRIVE_RESUME_REJECTED_WARNING = 'google_drive_store_resume_cursor_rejected';
export const GOOGLE_DRIVE_INGEST_EXCLUSION_WARNING =
  'google_drive_store_ingest_exclusion';
const GOOGLE_DRIVE_SCOPED_CHECKPOINT_PREFIX = 'gds1:';

export interface GoogleDriveConnectorStoreSyncRequest {
  max_files?: number;
  max_content_files?: number;
  query?: string;
}

export interface GoogleDriveConnectorStoreSyncResult {
  provider: typeof GOOGLE_DRIVE_PROVIDER;
  account: string;
  internal: ConnectorStoreSyncSummary;
  secure: ConnectorStoreSyncSummary;
}

export interface GoogleDriveConnectorStoreReceipt {
  kind:
    | typeof GOOGLE_DRIVE_STORE_PULL_RECEIPT_KIND
    | typeof GOOGLE_DRIVE_STORE_RECONCILE_RECEIPT_KIND;
  status: 'progress' | 'idle';
  counts: {
    api_requests: number;
    daily_api_request_budget: number;
    /**
     * Provider traversals this run spent. Always 1: the internal and secure
     * stores share one listing pass. Two connectors used to traverse
     * independently, doubling every Drive request for identical pages.
     */
    provider_traversals: number;
    items_seen: number;
    content_reads: number;
    content_read_cap: number;
    content_reads_failed: number;
    internal_items_indexed: number;
    internal_items_tombstoned: number;
    internal_items_rejected: number;
    internal_items_excluded: number;
    internal_items_excluded_unevaluable: number;
    internal_chunks_indexed: number;
    internal_chunks_embedded: number;
    secure_items_indexed: number;
    secure_items_tombstoned: number;
    secure_items_rejected: number;
    secure_items_excluded: number;
    secure_items_excluded_unevaluable: number;
    secure_chunks_indexed: number;
    secure_chunks_embedded: number;
    /** 1 when the run continued a durable checkpoint instead of starting over. */
    resumed_from_checkpoint: number;
    /**
     * 1 when a resume point was present but unusable and the run traversed
     * fresh. Carried as a count because the shared scheduler collapses unknown
     * warning tokens, and this signal must stay legible in scheduler status.
     */
    resume_cursor_rejected: number;
    /** 1 when the provider traversal reached its final page in this run. */
    traversal_complete: number;
    /** Always 0 for Drive: deletion semantics are unproven until a later leg. */
    absence_authoritative: number;
    /** Present once the lane's Public store exists and ran. */
    public_items_indexed?: number;
    public_chunks_indexed?: number;
    public_chunks_embedded?: number;
    /** Present when this run routed new items by their recorded tiers. */
    tier_routed_items?: number;
    tier_pending_items?: number;
    tier_secret_items?: number;
    tier_moves_queued?: number;
  };
  api_usage: {
    utc_day: string;
  };
  warnings?: string[];
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    provider_cursor_exposed: false;
    absence_authority: 'partial_window';
    tombstones_applied: false;
  };
  receipt_sha256: string;
}

export interface GoogleDriveConnectorStoreTaskOutcome {
  receipt: GoogleDriveConnectorStoreReceipt;
  /**
   * Scheduler-private durable resume point. `null` clears the checkpoint after
   * a completed traversal. It crosses only the scheduler state store, never a
   * counts-only surface.
   */
  checkpoint: string | null;
}

export interface GoogleDriveStorePullRequest {
  attempted_at?: string;
  /** Durable scheduler checkpoint; never returned from this surface. */
  checkpoint?: string;
  max_items?: number;
  /**
   * Who initiated this run. An operator run is never refused by the Drive
   * daily request budget (owner ruling 2026-08-19); anything but the exact
   * literal 'operator' fails closed to 'scheduled', and the provider's own
   * refusals bind either way.
   */
  provenance?: SourceInvocationProvenance;
}

export interface GoogleDriveStoreReconcileRequest {
  attempted_at?: string;
  /** Same contract as GoogleDriveStorePullRequest.provenance. */
  provenance?: SourceInvocationProvenance;
}

export interface GoogleDriveConnectorStoreSyncHandler {
  sync(request?: GoogleDriveConnectorStoreSyncRequest): Promise<GoogleDriveConnectorStoreSyncResult>;
  pull(request?: GoogleDriveStorePullRequest): Promise<GoogleDriveConnectorStoreTaskOutcome>;
  reconcile(request?: GoogleDriveStoreReconcileRequest): Promise<GoogleDriveConnectorStoreTaskOutcome>;
  lastStoreRunCompletedAt(): string | undefined;
  requestBudgetStatus(): GoogleRequestBudgetStatus | undefined;
}

export interface GoogleDriveConnectorStoreSyncOptions extends GoogleDriveSourceConnectorOptions {
  /**
   * The owner's sensitivity map for this lane's placement policy and its
   * recorded four-tier decisions. Loaded from the environment when omitted.
   */
  sensitivityMap?: SensitivityMap;
  internalStore: LocalConnectorStore;
  secureStore: LocalConnectorStore;
  /**
   * In-run embedding providers. Without them a dark pull fills both stores with
   * chunks and zero embeddings, so hasEmbeddings() stays false and the corpus
   * can never become servable — the defect that made the whole lane inert.
   */
  internalEmbeddingProvider?: SourceEmbeddingProvider;
  secureEmbeddingProvider?: SourceEmbeddingProvider;
  config?: GoogleDriveLiveSyncConfig;
  /**
   * The lane's per-tier stores (tiered-store-set.ts). Omitted: a set over the
   * internal and secure stores, with the Public store below when given.
   */
  tierSet?: TieredStoreSet;
  publicStore?: { open: () => LocalConnectorStore; exists: () => boolean };
  secretLocations?: SecretLocationsIndex;
  onTierLegOpened?: (store: LocalConnectorStore) => void;
}

export function createGoogleDriveConnectorStoreSyncHandler(
  options: GoogleDriveConnectorStoreSyncOptions,
): GoogleDriveConnectorStoreSyncHandler {
  const env = options.env ?? process.env;
  const config = options.config ?? defaultGoogleDriveLiveSyncConfig(env);
  const account = options.account?.trim() || accountFromGoogleHandle(options.credentialHandle);
  const connectorId = googleDriveCursorConnectorId(account, options.scope);
  if (
    options.secureEmbeddingProvider
    && !isApprovedSecureSourceEmbeddingProvider(options.secureEmbeddingProvider)
  ) {
    throw new Error('Google Drive secure_local embeddings require a local/private or approved Venice embedding provider.');
  }
  const classification = googleDriveConnectorStoreClassification(
    options.sensitivityMap ?? loadGoogleSensitivityMap(env),
  );
  const buildConnector = (overrides: {
    maxFiles?: number;
    maxContentFiles?: number;
    query?: string;
    provenance?: SourceInvocationProvenance;
  } = {}) => new GoogleDriveSourceConnector({
    ...options,
    ...(overrides.maxFiles !== undefined ? { maxFiles: overrides.maxFiles } : {}),
    maxContentFiles: overrides.maxContentFiles
      ?? options.maxContentFiles
      ?? DEFAULT_GOOGLE_DRIVE_CONTENT_MAX_FILES,
    ...(overrides.query ? { query: overrides.query } : {}),
    // Stated last and unconditionally, so it is a property of THIS run and
    // nothing else. Handler options are spread above and share the connector
    // option type; without this line a handler constructed once with an
    // operator provenance would exempt every later scheduled run it served.
    provenance: sourceInvocationProvenance(overrides.provenance),
  });

  const sensitivityMap = options.sensitivityMap ?? loadGoogleSensitivityMap(env);
  const tierSet = options.tierSet ?? createLaneTieredStoreSet({
    setId: connectorId,
    internalStore: options.internalStore,
    secureStore: options.secureStore,
    ...(options.publicStore
      ? { publicLeg: { corpusId: GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID, ...options.publicStore } }
      : {}),
    ...(options.internalEmbeddingProvider ? { internalEmbeddingProvider: options.internalEmbeddingProvider } : {}),
    ...(options.secureEmbeddingProvider ? { secureEmbeddingProvider: options.secureEmbeddingProvider } : {}),
    ...(sensitivityMap ? { tierClassification: { sensitivityMap } } : {}),
    ...(options.secretLocations ? { secretLocations: options.secretLocations } : {}),
    ...(options.onTierLegOpened ? { onLegOpened: (store) => options.onTierLegOpened!(store) } : {}),
  });

  const runBothStores = async (input: {
    connector: GoogleDriveSourceConnector;
    maxItems?: number;
    cursor?: string;
    reconcile?: boolean;
  }): Promise<DriveStoreRun> => {
    // One provider traversal feeds every tier store: the set records it on
    // its first pass and replays it to the other legs, routes each NEW item
    // by its recorded tiers, and leaves every existing item on the lane's own
    // placement. Its resume point commits only after every leg did.
    const traversal = scopedTraversal(input.connector, connectorId);
    const sync = {
      fetchContent: true,
      classification,
      ...(options.scope
        ? {
            sourceScopeObservation: (item: RawItem) => ({
              accountGeneration: options.scope!.generation,
              scopeRevision: options.scope!.revision,
              folderKeys: Array.isArray(item.metadata['folderAncestorIds'])
                ? item.metadata['folderAncestorIds'].filter((key): key is string => typeof key === 'string')
                : [],
            }),
          }
        : {}),
      ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.reconcile
        ? {
          reconcileFullSnapshot: true,
          reconcileFullSnapshotScope: { provider: GOOGLE_DRIVE_PROVIDER, accountScope: account },
          // Weakest honest authority: Drive deletion semantics are unproven on
          // this path (trashed files simply leave the default query), so
          // absence is never evidence of removal and nothing is tombstoned.
          // Upgrading this is a later tranche with its own proof.
          reconcileAbsenceAuthority: 'partial_window' as const,
        }
        : {}),
    };
    const run = await tierSet.sync(traversal, sync, { commitCursor: input.reconcile !== true });
    return {
      internal: legOf(run, 'internal'),
      secure: legOf(run, 'secure_local'),
      ...(run.byDomain.public_safe ? { public: legOf(run, 'public_safe') } : {}),
      routing: run.routing,
      traversal: input.connector.traversalStatus(),
    };
  };

  return {
    async sync(
      request: GoogleDriveConnectorStoreSyncRequest = {},
    ): Promise<GoogleDriveConnectorStoreSyncResult> {
      const maxFiles = request.max_files ?? options.maxFiles;
      const run = await runBothStores({
        connector: buildConnector({
          ...(maxFiles !== undefined ? { maxFiles } : {}),
          ...(request.max_content_files !== undefined
            ? { maxContentFiles: request.max_content_files }
            : {}),
          ...(request.query ? { query: request.query } : {}),
        }),
        ...(maxFiles !== undefined ? { maxItems: maxFiles } : {}),
      });
      return {
        provider: GOOGLE_DRIVE_PROVIDER,
        account,
        internal: run.internal.sync,
        secure: run.secure.sync,
      };
    },

    async pull(
      request: GoogleDriveStorePullRequest = {},
    ): Promise<GoogleDriveConnectorStoreTaskOutcome> {
      const maxItems = boundedMaxItems(request.max_items, config.storePullMaxItems);
      const warnings: string[] = [];
      // The scheduler envelope outranks the store row, as it does on the Gmail
      // lane. The internal leg commits its advanced cursor BEFORE the secure
      // leg runs, so preferring the store row resumes past a window the secure
      // store never received once anything between the two legs throws — a skip
      // the watermark then makes permanent.
      //
      // The store row stays as the fallback for an envelope that is absent or
      // unusable: wiped scheduler state, or a last run that was an uncursored
      // reconcile. Scoped to the connector because Gmail writes this same
      // internal store, and to completed runs because an unfinished row still
      // holds the cursor its run STARTED from.
      const envelope = request.checkpoint?.trim() || undefined;
      const envelopeCursor = googleDriveCheckpointCursor(envelope, connectorId, options.scope !== undefined);
      const envelopeUsable = isGoogleDriveConnectorCursor(envelopeCursor);
      // The fallback is the tier set's committed resume point, written only
      // after every leg of a run committed; a store written before P1b falls
      // back to its own completed run as before.
      const candidate = envelopeUsable
        ? envelopeCursor
        : tierSet.committedCursor(connectorId)?.cursor
          ?? options.internalStore.lastCompletedSyncRun(connectorId)?.cursor;
      let resume = isGoogleDriveConnectorCursor(candidate) ? candidate : undefined;
      if ((envelope !== undefined && !envelopeUsable) || (candidate !== undefined && resume === undefined)) {
        warnings.push(GOOGLE_DRIVE_RESUME_REJECTED_WARNING);
      }

      const provenance = sourceInvocationProvenance(request.provenance);
      let connector = buildConnector({ maxFiles: maxItems, provenance });
      let run: DriveStoreRun;
      try {
        run = await runBothStores({
          connector,
          maxItems,
          ...(resume ? { cursor: resume } : {}),
        });
      } catch (error) {
        // A page token is provider state with an unpublished lifetime. A
        // provider that rejects the resume point must not park the lane: drop
        // the checkpoint and traverse fresh, with a counts-only warning.
        if (resume === undefined || !isRejectedCursorError(error)) throw error;
        warnings.push(GOOGLE_DRIVE_RESUME_REJECTED_WARNING);
        resume = undefined;
        connector = buildConnector({ maxFiles: maxItems, provenance });
        run = await runBothStores({ connector, maxItems });
      }

      return taskOutcome({
        kind: GOOGLE_DRIVE_STORE_PULL_RECEIPT_KIND,
        run,
        usage: connector.requestBudgetStatus(),
        resumed: resume !== undefined,
        warnings,
        ...(options.scope ? { checkpointConnectorId: connectorId } : {}),
      });
    },

    async reconcile(
      request: GoogleDriveStoreReconcileRequest = {},
    ): Promise<GoogleDriveConnectorStoreTaskOutcome> {
      // Deliberately un-cursored and un-bounded: the shared spine only treats a
      // traversal as a full snapshot when neither a cursor nor a maxItems bound
      // was supplied and it reached a done page.
      const connector = buildConnector({
        maxFiles: MAX_RECONCILE_FILES,
        maxContentFiles: MAX_RECONCILE_CONTENT_FILES,
        provenance: sourceInvocationProvenance(request.provenance),
      });
      const run = await runBothStores({ connector, reconcile: true });
      return taskOutcome({
        kind: GOOGLE_DRIVE_STORE_RECONCILE_RECEIPT_KIND,
        run,
        usage: connector.requestBudgetStatus(),
        resumed: false,
        warnings: [],
      });
    },

    lastStoreRunCompletedAt: () => latestCompletedAt([
      options.internalStore.status().lastSyncRun?.completedAt,
      options.secureStore.status().lastSyncRun?.completedAt,
    ]),
    requestBudgetStatus: () => options.requestBudget?.status(),
  };
}

/**
 * The connector's own hard ceiling. The reconcile task passes no maxItems to
 * the spine — that is what makes the traversal a snapshot candidate — but the
 * connector still needs a listing bound, and its ceiling is the widest honest
 * one available.
 */
const MAX_RECONCILE_FILES = 1_000;

/**
 * The reconcile's own content budget, which is also its coverage bound.
 *
 * The connector's content cap BOUNDS the traversal — a page is never longer
 * than the remaining budget, and the loop stops on a page boundary once that
 * budget is spent. A reconcile that inherited the incremental lane's cap
 * therefore stopped after 50 files and covered a twentieth of the window above,
 * while still reporting a snapshot pass.
 *
 * Deliberately below MAX_RECONCILE_FILES, because the day counter is real. A
 * run costs one content read per readable file plus one list page per 100, so
 * the full 1,000 would cost ~1,010 requests of a 3,000-request default day, and
 * the half-hourly head pull already claims up to 48 x (1 list + 50 content) =
 * 2,448 of it. 500 costs ~505, fits inside the remainder, and leaves room for
 * the folder-ancestry lookups a folder-rule host spends. The head is the only
 * lane that can fall behind the provider, so it is not the one to starve for a
 * pass that tombstones nothing.
 *
 * A file the connector reads no text for costs no content budget, so a window
 * holding more than 500 unreadable files is still traversed whole.
 */
const MAX_RECONCILE_CONTENT_FILES = 500;

interface DriveStoreRunLeg {
  sync: ConnectorStoreSyncSummary;
  embed: ConnectorStoreEmbedSummary | undefined;
}

interface DriveStoreRun {
  internal: DriveStoreRunLeg;
  secure: DriveStoreRunLeg;
  /** Present once the lane's Public store exists and ran. */
  public?: DriveStoreRunLeg;
  routing: TieredStoreRoutingCounts;
  traversal: ReturnType<GoogleDriveSourceConnector['traversalStatus']>;
}

function legOf(run: TieredStoreSetRun, domain: 'public_safe' | 'internal' | 'secure_local'): DriveStoreRunLeg {
  const leg = run.byDomain[domain];
  if (!leg) throw new Error(`The Google Drive ${domain} store did not run.`);
  return { sync: leg.sync, embed: leg.embed };
}

/** The connector under this lane's (scope-bound) cursor id. */
function scopedTraversal(
  connector: GoogleDriveSourceConnector,
  connectorId: string,
): SourceConnector {
  return {
    id: connectorId,
    family: connector.family,
    authenticate: () => connector.authenticate(),
    fetchItem: (localItemId: string): Promise<RawItem> => connector.fetchItem(localItemId),
    classificationSignals: (item: RawItem) => connector.classificationSignals(item),
    listItems: (options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> => connector.listItems(options),
  };
}

function googleDriveCursorConnectorId(
  account: string,
  scope: GoogleDriveConnectorStoreSyncOptions['scope'],
): string {
  if (!scope) return GOOGLE_DRIVE_PROVIDER;
  const digest = createHash('sha256')
    .update(`${account}\u0000${scope.generation}\u0000${scope.revision}`)
    .digest('hex')
    .slice(0, 24);
  return `${GOOGLE_DRIVE_PROVIDER}.scope.${digest}`;
}

function googleDriveScopedCheckpoint(cursor: string, connectorId: string): string {
  return `${GOOGLE_DRIVE_SCOPED_CHECKPOINT_PREFIX}${connectorId.slice(`${GOOGLE_DRIVE_PROVIDER}.scope.`.length)}:`
    + Buffer.from(cursor).toString('base64url');
}

function googleDriveCheckpointCursor(
  checkpoint: string | undefined,
  connectorId: string,
  scoped: boolean,
): string | undefined {
  if (!checkpoint) return undefined;
  if (!scoped) return checkpoint;
  const prefix = `${GOOGLE_DRIVE_SCOPED_CHECKPOINT_PREFIX}`
    + `${connectorId.slice(`${GOOGLE_DRIVE_PROVIDER}.scope.`.length)}:`;
  if (!checkpoint.startsWith(prefix)) return undefined;
  try {
    return Buffer.from(checkpoint.slice(prefix.length), 'base64url').toString('utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function taskOutcome(input: {
  kind: GoogleDriveConnectorStoreReceipt['kind'];
  run: DriveStoreRun;
  usage: GoogleRequestBudgetStatus | undefined;
  resumed: boolean;
  warnings: string[];
  checkpointConnectorId?: string;
}): GoogleDriveConnectorStoreTaskOutcome {
  // A reconcile is never a resume point. It traverses from the start of the
  // listing under the connector's own ceiling, so its position is behind the
  // incremental lane's by construction and handing it back moves the lane
  // backwards. The spine also refuses to persist it; both layers state it
  // because only one of them was ever the reason it looked correct.
  //
  const rawCheckpoint = input.kind === GOOGLE_DRIVE_STORE_RECONCILE_RECEIPT_KIND
    ? null
    : input.run.internal.sync.cursor ?? null;
  const checkpoint = rawCheckpoint && input.checkpointConnectorId
    ? googleDriveScopedCheckpoint(rawCheckpoint, input.checkpointConnectorId)
    : rawCheckpoint;
  const internalIndexed = input.run.internal.sync.itemsIndexed;
  const secureIndexed = input.run.secure.sync.itemsIndexed;
  const internalTombstoned = input.run.internal.sync.itemsTombstoned;
  const secureTombstoned = input.run.secure.sync.itemsTombstoned;
  const internalEmbedded = input.run.internal.embed?.chunksEmbedded ?? 0;
  const secureEmbedded = input.run.secure.embed?.chunksEmbedded ?? 0;
  const internalExcluded = input.run.internal.sync.itemsExcluded;
  const internalExcludedUnevaluable = input.run.internal.sync.exclusions.items_excluded_unevaluable;
  const secureExcluded = input.run.secure.sync.itemsExcluded;
  const secureExcludedUnevaluable = input.run.secure.sync.exclusions.items_excluded_unevaluable;
  const publicLeg = input.run.public;
  const changed = internalIndexed > 0
    || secureIndexed > 0
    || internalTombstoned > 0
    || secureTombstoned > 0
    || internalEmbedded > 0
    || secureEmbedded > 0
    || (publicLeg?.sync.itemsIndexed ?? 0) > 0
    || (publicLeg?.embed?.chunksEmbedded ?? 0) > 0;
  const warnings = [...new Set(input.warnings)];
  if ((internalExcluded > 0 || secureExcluded > 0)
    && !warnings.includes(GOOGLE_DRIVE_INGEST_EXCLUSION_WARNING)) {
    warnings.push(GOOGLE_DRIVE_INGEST_EXCLUSION_WARNING);
  }
  const receipt: Omit<GoogleDriveConnectorStoreReceipt, 'receipt_sha256'> = {
    kind: input.kind,
    status: changed ? 'progress' : 'idle',
    counts: {
      api_requests: input.usage?.requests ?? 0,
      daily_api_request_budget: input.usage?.dailyRequestBudget ?? 0,
      provider_traversals: 1,
      items_seen: input.run.internal.sync.itemsSeen,
      content_reads: input.run.traversal.contentReads,
      content_read_cap: input.run.traversal.contentReadCap,
      content_reads_failed: input.run.traversal.contentReadFailures,
      internal_items_indexed: internalIndexed,
      internal_items_tombstoned: internalTombstoned,
      internal_items_rejected: input.run.internal.sync.itemsRejected,
      internal_items_excluded: internalExcluded,
      internal_items_excluded_unevaluable: internalExcludedUnevaluable,
      internal_chunks_indexed: input.run.internal.sync.chunksIndexed,
      internal_chunks_embedded: internalEmbedded,
      secure_items_indexed: secureIndexed,
      secure_items_tombstoned: secureTombstoned,
      secure_items_rejected: input.run.secure.sync.itemsRejected,
      secure_items_excluded: secureExcluded,
      secure_items_excluded_unevaluable: secureExcludedUnevaluable,
      secure_chunks_indexed: input.run.secure.sync.chunksIndexed,
      secure_chunks_embedded: secureEmbedded,
      resumed_from_checkpoint: Number(input.resumed),
      resume_cursor_rejected: Number(warnings.includes(GOOGLE_DRIVE_RESUME_REJECTED_WARNING)),
      // The spine's own record of whether the listing ran out, never an
      // inference from `checkpoint`. This lane nulls that checkpoint outright
      // for a reconcile, so reading completion off it called every reconcile a
      // full traversal — including one the content budget stopped halfway.
      traversal_complete: Number(input.run.internal.sync.traversalComplete),
      absence_authoritative: 0,
      ...tieredReceiptCounts(input.run),
    },
    api_usage: {
      utc_day: input.usage?.utcDay ?? '',
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      provider_cursor_exposed: false,
      absence_authority: 'partial_window',
      tombstones_applied: false,
    },
  };
  return {
    receipt: { ...receipt, receipt_sha256: googleDriveReceiptDigest(receipt) },
    checkpoint,
  };
}

/**
 * Self-digest over every field the receipt carries except the digest itself.
 * A verifier recomputes it from the receipt alone; nothing private is needed.
 */
export function googleDriveReceiptDigest(
  receipt: Omit<GoogleDriveConnectorStoreReceipt, 'receipt_sha256'>,
): string {
  return createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
}

/**
 * Counts the lane gained with per-tier stores. Present only when there is
 * something to say, so a receipt from a run that routed nothing is exactly
 * the pre-P1b receipt.
 */
function tieredReceiptCounts(run: DriveStoreRun): Partial<GoogleDriveConnectorStoreReceipt['counts']> {
  const routing = run.routing;
  return {
    ...(run.public
      ? {
          public_items_indexed: run.public.sync.itemsIndexed,
          public_chunks_indexed: run.public.sync.chunksIndexed,
          public_chunks_embedded: run.public.embed?.chunksEmbedded ?? 0,
        }
      : {}),
    ...(routing.itemsRouted + routing.itemsSecrets + routing.movesQueued + routing.routedDeletions > 0
      ? {
          tier_routed_items: routing.itemsRouted,
          tier_pending_items: routing.itemsPendingHeld,
          tier_secret_items: routing.itemsSecrets,
          tier_moves_queued: routing.movesQueued,
        }
      : {}),
  };
}

function isRejectedCursorError(error: unknown): boolean {
  if (error instanceof TypeError) return /cursor is invalid/i.test(error.message);
  if (!(error instanceof Error)) return false;
  // A stale Drive page token comes back as a 400/404 on files.list. 401/403 are
  // credential problems and 429 is the rate limiter; neither is the cursor's
  // fault and neither may be papered over by traversing from scratch.
  const match = /Google Drive API request failed \((\d{3})\)/.exec(error.message);
  const status = match?.[1] ? Number(match[1]) : undefined;
  return status !== undefined && status >= 400 && status < 500
    && status !== 401 && status !== 403 && status !== 429;
}

function boundedMaxItems(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Google Drive store pull max_items must be a positive integer.');
  }
  return Math.min(value, fallback);
}

function latestCompletedAt(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}
