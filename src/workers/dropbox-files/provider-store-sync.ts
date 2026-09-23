// Product-owned Dropbox control plane around Contract 1.
//
// Provider I/O stays in connector.ts. Storage and later extraction/embedding
// stay in the shared spine. One opaque connector id is derived per approved
// root and approved-scope generation/revision, so two roots or two explicit
// approvals never overwrite each other's durable provider cursor.

import { createHash } from 'node:crypto';
import type {
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  isApprovedSecureSourceEmbeddingProvider,
  type SourceEmbeddingProvider,
} from '../source-index/embeddings.ts';
import type { CredentialBroker, CredentialBrokerFetch } from '../credential-broker/index.ts';
import type { ConnectorStoreSyncSummary, LocalConnectorStore } from '../connector-store/index.ts';
import {
  tieredLaneReceiptCounts,
  TIER_DOMAIN_ORDER,
  type TieredLaneReceiptCounts,
  type TieredStoreSet,
} from '../connector-store/tiered-store-set.ts';
import { DROPBOX_STORE_PLACEMENT } from './connector-store.ts';
import {
  createDropboxSourceConnector,
  type DropboxContentScope,
} from './connector.ts';
import {
  isDropboxCursorResetError,
  type DropboxContentDownloadClient,
  type DropboxMetadataClient,
} from './provider-client.ts';

export const DROPBOX_PROVIDER_STORE_RECEIPT_KIND = 'dropbox_provider_connector_store_pull_receipt';

const DROPBOX_RESUME_CURSOR_RESET_WARNING =
  'provider_cursor_reset: provider invalidated the resume cursor; traversal restarted from the beginning.';
const DROPBOX_SCOPED_CHECKPOINT_PREFIX = 'dbxs1:';

export interface DropboxProviderStorePullRequest {
  approved_scope_key: string;
  checkpoint?: string;
  max_items?: number;
}

export interface DropboxProviderStoreReceipt {
  kind: typeof DROPBOX_PROVIDER_STORE_RECEIPT_KIND;
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
    resumed_from_checkpoint: number;
    page_digest_restarts: number;
    /**
     * 1 when the provider invalidated the resume cursor and this run traversed
     * fresh instead. Carried as a count because the shared scheduler collapses
     * unknown warning tokens, and a wedged cursor must stay legible in status.
     */
    resume_cursor_reset: number;
  } & TieredLaneReceiptCounts;
  warnings?: string[];
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    provider_cursor_exposed: false;
    native_recursive_only: true;
    content_extraction: 'shared_factory';
  };
  receipt_sha256: string;
}

export interface DropboxProviderStoreTaskOutcome {
  receipt: DropboxProviderStoreReceipt;
  checkpoint: string | null;
}

export interface DropboxProviderStoreSyncHandler {
  pull(request: DropboxProviderStorePullRequest): Promise<DropboxProviderStoreTaskOutcome>;
  connectorIdForScope(approvedScopeKey: string): string;
  lastStoreRunCompletedAt(): string | undefined;
}

export interface DropboxProviderStoreSyncHandlerOptions {
  store: LocalConnectorStore;
  account: string;
  credentialHandle?: string;
  broker?: CredentialBroker;
  metadataClient?: DropboxMetadataClient;
  downloadClient?: DropboxContentDownloadClient;
  fetch?: CredentialBrokerFetch;
  apiBaseUrl?: string;
  contentBaseUrl?: string;
  /** Kept here so construction rejects an unsafe secure-lane provider early. */
  embeddingProvider?: SourceEmbeddingProvider;
  scope?: DropboxContentScope;
  /**
   * The lane's per-tier stores (tier-set.ts), whose secure leg is `store`.
   * Absent: the single-store lane exactly as before per-item routing.
   */
  tierSet?: TieredStoreSet;
}

export function createDropboxProviderStoreSyncHandler(
  options: DropboxProviderStoreSyncHandlerOptions,
): DropboxProviderStoreSyncHandler {
  const account = required(options.account, 'Dropbox connector-store account');
  if (options.embeddingProvider && !isApprovedSecureSourceEmbeddingProvider(options.embeddingProvider)) {
    throw new Error('Dropbox secure_local embeddings require a local/private or approved Venice embedding provider.');
  }

  const connectorIdForScope = (approvedScopeKey: string): string =>
    dropboxConnectorIdForScope(account, approvedScopeKey, options.scope);
  const tierSet = options.tierSet;
  if (tierSet && tierSet.legSpec('secure_local')?.store !== options.store) {
    throw new Error('The Dropbox tier set\'s secure leg must be the lane\'s own store.');
  }
  // A deleted entry names a path; the file's row may sit in any tier store.
  const deletedItemIdentityResolver = tierSet
    ? {
        activeIdentityForLocatorIfIndexed(input: Parameters<LocalConnectorStore['activeIdentityForLocatorIfIndexed']>[0]) {
          for (const domain of ['secure_local', 'internal', 'public_safe'] as const) {
            const identity = tierSet.store(domain)?.activeIdentityForLocatorIfIndexed(input);
            if (identity) return identity;
          }
          return undefined;
        },
      }
    : options.store;

  return {
    connectorIdForScope,

    async pull(request): Promise<DropboxProviderStoreTaskOutcome> {
      const approvedScopeKey = required(request.approved_scope_key, 'Dropbox approved scope key');
      const connectorId = connectorIdForScope(approvedScopeKey);
      // The tier set's committed resume point first: it is written only after
      // every tier store committed, so a run that died between stores resumes
      // behind the item it had not finished placing.
      const candidate = tierSet?.committedCursor(connectorId)?.cursor
        ?? options.store.lastCompletedSyncRun(connectorId)?.cursor
        ?? dropboxCheckpointCursor(request.checkpoint, connectorId, options.scope !== undefined)
        ?? undefined;
      const maxItems = request.max_items === undefined
        ? undefined
        : positiveInteger(request.max_items);

      const runTraversal = async (cursor: string | undefined): Promise<DropboxTraversalRun> => {
        let pageDigestRestarts = 0;
        const observed = observedCompletion(createDropboxSourceConnector({
          account,
          approvedScopeKey,
          connectorId,
          ...(options.credentialHandle ? { credentialHandle: options.credentialHandle } : {}),
          ...(options.broker ? { broker: options.broker } : {}),
          ...(options.metadataClient ? { metadataClient: options.metadataClient } : {}),
          ...(options.downloadClient ? { downloadClient: options.downloadClient } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
          ...(options.contentBaseUrl ? { contentBaseUrl: options.contentBaseUrl } : {}),
          ...(options.scope ? { scope: options.scope } : {}),
          deletedItemIdentityResolver,
          onPageDigestRestart: () => {
            pageDigestRestarts += 1;
          },
        }));
        const syncOptions = {
          placement: DROPBOX_STORE_PLACEMENT,
          fetchContent: false,
          ...(options.scope
            ? {
                sourceScopeObservation: () => ({
                  accountGeneration: options.scope!.generation,
                  scopeRevision: options.scope!.revision,
                  folderKeys: [],
                }),
              }
            : {}),
          ...(maxItems !== undefined ? { maxItems } : {}),
          ...(cursor ? { cursor } : {}),
        };
        if (!tierSet) {
          const sync = await options.store.syncFromConnector(observed.connector, syncOptions);
          return { sync, legs: [sync], completed: observed.completed(), pageDigestRestarts };
        }
        // One traversal feeds every tier store. Existing files keep the lane
        // placement above; a new file's names are routed by its metadata tier.
        const run = await tierSet.sync(observed.connector, syncOptions);
        const secure = run.byDomain.secure_local;
        if (!secure) throw new Error('The Dropbox secure store did not run.');
        return {
          sync: secure.sync,
          legs: TIER_DOMAIN_ORDER.flatMap((domain) => run.byDomain[domain] ? [run.byDomain[domain]!.sync] : []),
          tiered: tieredLaneReceiptCounts({
            ...(run.byDomain.public_safe ? { public: run.byDomain.public_safe } : {}),
            routing: run.routing,
          }),
          completed: observed.completed(),
          pageDigestRestarts,
        };
      };

      let resumed = candidate !== undefined;
      let cursorReset = false;
      let run: DropboxTraversalRun;
      try {
        run = await runTraversal(candidate);
      } catch (error) {
        // A provider-invalidated cursor is dead provider state, not a lane
        // failure. Nothing else clears it — lastCompletedSyncRun hands the same
        // cursor back on every pull — so without this the lane fails
        // identically forever. Only a reset qualifies: a rate limit or a
        // transient failure keeps a checkpoint that is still good, and
        // restarting on those throws away real traversal progress.
        if (candidate === undefined || !isDropboxCursorResetError(error)) throw error;
        cursorReset = true;
        resumed = false;
        run = await runTraversal(undefined);
      }

      const sync = run.sync;
      // Every tier store saw the same listing; what each one wrote is summed.
      const sum = (pick: (leg: ConnectorStoreSyncSummary) => number): number =>
        run.legs.reduce((total, leg) => total + pick(leg), 0);
      const changed = sum((leg) => leg.itemsChanged) > 0 || sum((leg) => leg.itemsTombstoned) > 0;
      const warnings = [...new Set([
        ...run.legs.flatMap((leg) => leg.gaps),
        ...(run.pageDigestRestarts > 0
          ? ['provider_page_digest_changed: bounded resume restarted at the changed page boundary.']
          : []),
        ...(cursorReset ? [DROPBOX_RESUME_CURSOR_RESET_WARNING] : []),
      ])];
      const receiptWithoutDigest: Omit<DropboxProviderStoreReceipt, 'receipt_sha256'> = {
        kind: DROPBOX_PROVIDER_STORE_RECEIPT_KIND,
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
          resumed_from_checkpoint: Number(resumed),
          page_digest_restarts: run.pageDigestRestarts,
          resume_cursor_reset: Number(cursorReset),
          ...(run.tiered ?? {}),
        },
        ...(warnings.length > 0 ? { warnings } : {}),
        policy: {
          counts_only: true,
          raw_source_exposed: false,
          source_text_returned: false,
          provider_cursor_exposed: false,
          native_recursive_only: true,
          content_extraction: 'shared_factory',
        },
      };
      return {
        receipt: {
          ...receiptWithoutDigest,
          receipt_sha256: createHash('sha256')
            .update(JSON.stringify(receiptWithoutDigest))
            .digest('hex'),
        },
        checkpoint: dropboxScopedCheckpoint(sync.cursor, connectorId, options.scope !== undefined),
      };
    },

    lastStoreRunCompletedAt: () => options.store.status().lastSyncRun?.completedAt,
  };
}

export function dropboxConnectorIdForScope(
  account: string,
  approvedScopeKey: string,
  scope?: Pick<DropboxContentScope, 'generation' | 'revision'>,
): string {
  const normalizedAccount = required(account, 'Dropbox connector account');
  const normalizedScope = required(approvedScopeKey, 'Dropbox approved scope key');
  const approvedScopeIdentity = scope
    ? `\u0000${required(scope.generation, 'Dropbox approved scope generation')}`
      + `\u0000${required(scope.revision, 'Dropbox approved scope revision')}`
    : '';
  const scopeHash = createHash('sha256')
    .update(`${normalizedAccount}\u0000${normalizedScope}${approvedScopeIdentity}`)
    .digest('hex')
    .slice(0, 24);
  return `dropbox.files.${scopeHash}`;
}

function dropboxScopedCheckpoint(
  cursor: string | undefined,
  connectorId: string,
  scoped: boolean,
): string | null {
  if (!cursor) return null;
  if (!scoped) return cursor;
  return `${DROPBOX_SCOPED_CHECKPOINT_PREFIX}${connectorId.slice('dropbox.files.'.length)}:`
    + Buffer.from(cursor).toString('base64url');
}

function dropboxCheckpointCursor(
  checkpoint: string | undefined,
  connectorId: string,
  scoped: boolean,
): string | undefined {
  const normalized = checkpoint?.trim();
  if (!normalized) return undefined;
  if (!scoped) return normalized;
  const prefix = `${DROPBOX_SCOPED_CHECKPOINT_PREFIX}${connectorId.slice('dropbox.files.'.length)}:`;
  if (!normalized.startsWith(prefix)) return undefined;
  try {
    return Buffer.from(normalized.slice(prefix.length), 'base64url').toString('utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

interface DropboxTraversalRun {
  /** The lane's original (secure) store's run: listing-level counts and the cursor. */
  sync: ConnectorStoreSyncSummary;
  /** Every tier store's run, for the counts each one wrote. */
  legs: ConnectorStoreSyncSummary[];
  tiered?: TieredLaneReceiptCounts;
  completed: boolean;
  pageDigestRestarts: number;
}

function observedCompletion(connector: SourceConnector): {
  connector: SourceConnector;
  completed(): boolean;
} {
  let completed = false;
  return {
    connector: {
      id: connector.id,
      family: connector.family,
      authenticate: () => connector.authenticate(),
      fetchItem: (localItemId) => connector.fetchItem(localItemId),
      classificationSignals: (item) => connector.classificationSignals(item),
      listItems(options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
        const pages = connector.listItems(options);
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          for await (const page of pages) {
            if (page.done) completed = true;
            yield page;
          }
        })();
      },
    },
    completed: () => completed,
  };
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Dropbox connector-store max_items must be a positive integer.');
  }
  return value;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}
