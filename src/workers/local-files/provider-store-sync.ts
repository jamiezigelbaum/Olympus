// Product-owned control plane around the local files connector: one pull per
// approved folder, into the lane's tier stores. The same shape as the other
// file lanes' handlers; what differs is where the resume point comes from (a
// change snapshot, not a provider cursor) and what a lost one means (list the
// folder again and treat the listing as a complete snapshot).

import { createHash } from 'node:crypto';
import type { SourceConnector, SourceConnectorListOptions, SourceConnectorListPage } from '../../core/contracts.ts';
import { isApprovedSecureSourceEmbeddingProvider, type SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import type { ConnectorStoreSyncSummary, LocalConnectorStore } from '../connector-store/index.ts';
import {
  tieredLaneReceiptCounts,
  TIER_DOMAIN_ORDER,
  type TieredLaneReceiptCounts,
  type TieredStoreSet,
} from '../connector-store/tiered-store-set.ts';
import {
  LOCAL_FILES_CURSOR_PREFIX,
  LOCAL_FILES_POLL_CURSOR,
  LocalFilesHistoryResetError,
  createLocalFilesSourceConnector,
  type LocalFilesStoreView,
  type LocalFilesWalkStats,
} from './connector.ts';
import { splitScopePath } from './paths.ts';
import {
  LOCAL_FILES_ACCOUNT_SCOPE,
  LOCAL_FILES_POLICY_SOURCE,
  LOCAL_FILES_PROVIDER,
  type LocalFilesContentScope,
} from './scope.ts';
import { LOCAL_FILES_STORE_PLACEMENT } from './store.ts';
import type { VolumeResolver } from './volume-identity.ts';
import type { WatchHub } from './watch-hub.ts';

export const LOCAL_FILES_PROVIDER_STORE_RECEIPT_KIND = 'local_files_provider_connector_store_pull_receipt';

const CHECKPOINT_PREFIX = 'lfs1:';

export interface LocalFilesProviderStorePullRequest {
  approved_scope_key: string;
  checkpoint?: string;
}

export interface LocalFilesProviderStoreReceipt {
  kind: typeof LOCAL_FILES_PROVIDER_STORE_RECEIPT_KIND;
  status: 'progress' | 'idle';
  counts: {
    items_seen: number;
    items_indexed: number;
    items_changed: number;
    items_tombstoned: number;
    deleted_events_applied: number;
    items_rejected: number;
    items_excluded: number;
    metadata_only_items: number;
    traversal_complete: number;
    /** 1 when this pass listed the whole folder; 0 when it replayed changes. */
    full_listing: number;
    /** 1 when a lost change history forced a full listing. */
    history_reset: number;
    folders_walked: number;
    /** Folders the pass could not read (permission, a disk that went away). */
    unreadable_folders: number;
    /** 1 when live change notifications are off and the folder is found on the poll. */
    live_updates_off: number;
  } & TieredLaneReceiptCounts;
  warnings?: string[];
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    content_extraction: 'shared_factory';
  };
  receipt_sha256: string;
}

export interface LocalFilesProviderStoreTaskOutcome {
  receipt: LocalFilesProviderStoreReceipt;
  checkpoint: string | null;
}

export interface LocalFilesProviderStoreSyncHandler {
  pull(request: LocalFilesProviderStorePullRequest): Promise<LocalFilesProviderStoreTaskOutcome>;
  connectorIdForScope(approvedScopeKey: string): string;
  lastStoreRunCompletedAt(): string | undefined;
}

export interface LocalFilesProviderStoreSyncHandlerOptions {
  store: LocalConnectorStore;
  scope: LocalFilesContentScope;
  volumes: VolumeResolver;
  hub?: WatchHub;
  snapshotDir: string;
  ignore?: readonly string[];
  tierSet: TieredStoreSet;
  embeddingProvider?: SourceEmbeddingProvider;
  /**
   * Asked before each pass. The worker's clean-up of what an earlier version
   * indexed inside Olympus's own folders (own-roots-cleanup.ts) rides here, so
   * a clean-up that did not finish at start goes on with the next pass. A
   * refusal to run never stops the pass.
   */
  beforePull?: () => Promise<unknown>;
  /** Test seam. */
  pageSize?: number;
}

/** The scope path inside an approved-scope key (`local_files.this_computer:/path`). */
export function localFilesRootOfApprovedScopeKey(approvedScopeKey: string): string {
  const prefix = `${LOCAL_FILES_POLICY_SOURCE}:`;
  if (!approvedScopeKey.startsWith(prefix)) throw new Error('This approved scope key is not a local folder.');
  const root = approvedScopeKey.slice(prefix.length);
  splitScopePath(root);
  return root;
}

export function localFilesConnectorIdForScope(
  approvedScopeKey: string,
  scope: Pick<LocalFilesContentScope, 'generation' | 'revision'>,
): string {
  const hash = createHash('sha256')
    .update(`${LOCAL_FILES_ACCOUNT_SCOPE}\u0000${approvedScopeKey}\u0000${scope.generation}\u0000${scope.revision}`)
    .digest('hex')
    .slice(0, 24);
  return `local.files.${hash}`;
}

/**
 * The store's side of a deletion: which indexed items a deleted path stands
 * for. A deleted path names a file or a whole folder whose items may sit in any
 * tier store, one item possibly in several (a names copy and a content copy).
 */
export function localFilesStoreView(tierSet: TieredStoreSet): LocalFilesStoreView {
  return {
    activeIdentityForLocatorIfIndexed(input) {
      for (const domain of TIER_DOMAIN_ORDER) {
        const identity = tierSet.store(domain)?.activeIdentityForLocatorIfIndexed(input);
        if (identity) return identity;
      }
      return undefined;
    },
    activeItemsUnderLocatorIfIndexed(input) {
      const union = new Map<string, { identity: import('../../core/source-index/types.ts').SourceItemIdentity; locatorUri: string }>();
      for (const domain of TIER_DOMAIN_ORDER) {
        for (const descendant of tierSet.store(domain)?.activeItemsUnderLocatorIfIndexed(input) ?? []) {
          if (!union.has(descendant.identity.providerItemId)) union.set(descendant.identity.providerItemId, descendant);
        }
      }
      return [...union.values()];
    },
    activeItemsDirectlyUnderRootIfIndexed(input) {
      const union = new Map<string, { identity: import('../../core/source-index/types.ts').SourceItemIdentity; locatorUri: string }>();
      for (const domain of TIER_DOMAIN_ORDER) {
        for (const child of tierSet.store(domain)?.activeItemsDirectlyUnderRootIfIndexed(input) ?? []) {
          if (!union.has(child.identity.providerItemId)) union.set(child.identity.providerItemId, child);
        }
      }
      return [...union.values()];
    },
    lookupsReady() {
      return TIER_DOMAIN_ORDER.every((domain) => tierSet.store(domain)?.locatorIdentityIndexReady() ?? true);
    },
  };
}

export function createLocalFilesProviderStoreSyncHandler(
  options: LocalFilesProviderStoreSyncHandlerOptions,
): LocalFilesProviderStoreSyncHandler {
  if (options.embeddingProvider && !isApprovedSecureSourceEmbeddingProvider(options.embeddingProvider)) {
    throw new Error('Local files secure_local embeddings require a local/private or approved Venice embedding provider.');
  }
  const tierSet = options.tierSet;
  if (tierSet.legSpec('secure_local')?.store !== options.store) {
    throw new Error('The local files tier set\'s secure leg must be the lane\'s own store.');
  }
  const connectorIdFor = (approvedScopeKey: string): string => localFilesConnectorIdForScope(approvedScopeKey, options.scope);

  const storeView = localFilesStoreView(tierSet);

  return {
    connectorIdForScope: connectorIdFor,

    async pull(request): Promise<LocalFilesProviderStoreTaskOutcome> {
      if (options.beforePull) {
        try { await options.beforePull(); } catch { /* the pass goes on; the clean-up is asked again at the next */ }
      }
      const approvedScopeKey = request.approved_scope_key.trim();
      const root = localFilesRootOfApprovedScopeKey(approvedScopeKey);
      const connectorId = connectorIdFor(approvedScopeKey);
      const priorCursor = tierSet.committedCursor(connectorId)?.cursor
        ?? options.store.lastCompletedSyncRun(connectorId)?.cursor
        ?? checkpointCursor(request.checkpoint, connectorId)
        ?? undefined;
      const resumable = priorCursor !== undefined
        && priorCursor.startsWith(LOCAL_FILES_CURSOR_PREFIX)
        && priorCursor !== LOCAL_FILES_POLL_CURSOR;

      const runTraversal = async (cursor: string | undefined): Promise<Traversal> => {
        const walk: LocalFilesWalkStats = { directories: 0, files: 0, unreadable: 0 };
        const observed = observeCompletion(createLocalFilesSourceConnector({
          connectorId,
          root,
          scope: options.scope,
          volumes: options.volumes,
          store: storeView,
          ...(options.hub
            ? { watch: { hub: options.hub, snapshotDir: options.snapshotDir, ...(options.ignore ? { ignore: options.ignore } : {}) } }
            : {}),
          ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
          onWalk: (stats) => { Object.assign(walk, stats); },
        }));
        const full = cursor === undefined;
        const syncOptions = {
          placement: LOCAL_FILES_STORE_PLACEMENT,
          fetchContent: false,
          sourceScopeObservation: () => ({
            accountGeneration: options.scope.generation,
            scopeRevision: options.scope.revision,
            folderKeys: [],
          }),
          ...(cursor ? { cursor } : {}),
        };
        const run = await tierSet.sync(observed.connector, syncOptions);
        const secure = run.byDomain.secure_local;
        if (!secure) throw new Error('The local files secure store did not run.');
        return {
          sync: secure.sync,
          legs: TIER_DOMAIN_ORDER.flatMap((domain) => run.byDomain[domain] ? [run.byDomain[domain]!.sync] : []),
          tiered: tieredLaneReceiptCounts({
            ...(run.byDomain.public_safe ? { public: run.byDomain.public_safe } : {}),
            routing: run.routing,
          }),
          completed: observed.completed(),
          walk,
          full,
        };
      };

      let historyReset = false;
      let run: Traversal;
      // A folder the watcher cannot vouch for is listed again, every pass.
      const liveOff = options.hub ? options.hub.rescanOnly() : true;
      try {
        run = await runTraversal(resumable && !liveOff ? priorCursor : undefined);
      } catch (error) {
        if (!(error instanceof LocalFilesHistoryResetError) || !resumable) throw error;
        historyReset = true;
        run = await runTraversal(undefined);
      }

      const sync = run.sync;
      const sum = (pick: (leg: ConnectorStoreSyncSummary) => number): number =>
        run.legs.reduce((total, leg) => total + pick(leg), 0);
      const changed = sum((leg) => leg.itemsChanged) > 0 || sum((leg) => leg.itemsTombstoned) > 0;
      const problems = options.hub?.problemsNow() ?? [];
      const liveUpdatesOff = liveOff || problems.length > 0;
      const warnings = [...new Set([
        ...run.legs.flatMap((leg) => leg.gaps),
        ...(run.walk.unreadable > 0 ? ['local_files_unreadable_folders'] : []),
        ...(problems.some((problem) => problem.kind === 'watch_limit_reached') ? ['local_files_watch_limit_reached'] : []),
        ...(liveUpdatesOff ? ['local_files_live_updates_off'] : []),
      ])];
      const receiptWithoutDigest: Omit<LocalFilesProviderStoreReceipt, 'receipt_sha256'> = {
        kind: LOCAL_FILES_PROVIDER_STORE_RECEIPT_KIND,
        status: changed ? 'progress' : 'idle',
        counts: {
          items_seen: sync.itemsSeen,
          items_indexed: sum((leg) => leg.itemsIndexed),
          items_changed: sum((leg) => leg.itemsChanged),
          items_tombstoned: sum((leg) => leg.itemsTombstoned),
          deleted_events_applied: sum((leg) => leg.deletedEventItemsTombstoned ?? 0),
          items_rejected: sum((leg) => leg.itemsRejected),
          items_excluded: sync.itemsExcluded,
          metadata_only_items: sync.itemsMetadataOnly,
          traversal_complete: Number(run.completed),
          full_listing: Number(run.full),
          history_reset: Number(historyReset),
          folders_walked: run.walk.directories,
          unreadable_folders: run.walk.unreadable,
          live_updates_off: Number(liveUpdatesOff),
          ...(run.tiered ?? {}),
        },
        ...(warnings.length > 0 ? { warnings } : {}),
        policy: {
          counts_only: true,
          raw_source_exposed: false,
          source_text_returned: false,
          content_extraction: 'shared_factory',
        },
      };
      return {
        receipt: {
          ...receiptWithoutDigest,
          receipt_sha256: createHash('sha256').update(JSON.stringify(receiptWithoutDigest)).digest('hex'),
        },
        checkpoint: scopedCheckpoint(sync.cursor, connectorId),
      };
    },

    lastStoreRunCompletedAt: () => options.store.status().lastSyncRun?.completedAt,
  };
}

interface Traversal {
  sync: ConnectorStoreSyncSummary;
  legs: ConnectorStoreSyncSummary[];
  tiered?: TieredLaneReceiptCounts;
  completed: boolean;
  walk: LocalFilesWalkStats;
  full: boolean;
}

function scopedCheckpoint(cursor: string | undefined, connectorId: string): string | null {
  if (!cursor) return null;
  return `${CHECKPOINT_PREFIX}${connectorId.slice('local.files.'.length)}:${Buffer.from(cursor).toString('base64url')}`;
}

function checkpointCursor(checkpoint: string | undefined, connectorId: string): string | undefined {
  const normalized = checkpoint?.trim();
  if (!normalized) return undefined;
  const prefix = `${CHECKPOINT_PREFIX}${connectorId.slice('local.files.'.length)}:`;
  if (!normalized.startsWith(prefix)) return undefined;
  try {
    return Buffer.from(normalized.slice(prefix.length), 'base64url').toString('utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function observeCompletion(connector: SourceConnector): { connector: SourceConnector; completed(): boolean } {
  let completed = false;
  const wrapped = Object.create(connector) as SourceConnector;
  wrapped.listItems = (listOptions?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> => {
    const pages = connector.listItems(listOptions);
    return (async function* (): AsyncGenerator<SourceConnectorListPage> {
      for await (const page of pages) {
        if (page.done) completed = true;
        yield page;
      }
    })();
  };
  return { connector: wrapped, completed: () => completed };
}
