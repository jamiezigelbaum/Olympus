// Product-owned Dropbox control plane around Contract 1.
//
// Provider I/O stays in connector.ts. Storage and later extraction/embedding
// stay in the shared spine. One opaque connector id is derived per approved
// root, so two roots never overwrite each other's durable provider cursor.

import { createHash } from 'node:crypto';
import type {
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import type { CredentialBroker, CredentialBrokerFetch } from '../credential-broker/index.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import {
  createDropboxSourceConnector,
} from './connector.ts';
import {
  isDropboxCursorResetError,
  type DropboxContentDownloadClient,
  type DropboxMetadataClient,
} from './provider-client.ts';

export const DROPBOX_PROVIDER_STORE_RECEIPT_KIND = 'dropbox_provider_connector_store_pull_receipt';

const DROPBOX_RESUME_CURSOR_RESET_WARNING =
  'provider_cursor_reset: provider invalidated the resume cursor; traversal restarted from the beginning.';

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
  };
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
}

export function createDropboxProviderStoreSyncHandler(
  options: DropboxProviderStoreSyncHandlerOptions,
): DropboxProviderStoreSyncHandler {
  const account = required(options.account, 'Dropbox connector-store account');
  if (options.embeddingProvider && options.embeddingProvider.backend !== 'local') {
    throw new Error('Dropbox secure_local embeddings require a local/private embedding provider.');
  }

  const connectorIdForScope = (approvedScopeKey: string): string =>
    dropboxConnectorIdForScope(account, approvedScopeKey);

  return {
    connectorIdForScope,

    async pull(request): Promise<DropboxProviderStoreTaskOutcome> {
      const approvedScopeKey = required(request.approved_scope_key, 'Dropbox approved scope key');
      const connectorId = connectorIdForScope(approvedScopeKey);
      const candidate = options.store.lastCompletedSyncRun(connectorId)?.cursor
        ?? request.checkpoint?.trim()
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
          deletedItemIdentityResolver: options.store,
          onPageDigestRestart: () => {
            pageDigestRestarts += 1;
          },
        }));
        const sync = await options.store.syncFromConnector(observed.connector, {
          fetchContent: false,
          ...(maxItems !== undefined ? { maxItems } : {}),
          ...(cursor ? { cursor } : {}),
        });
        return { sync, completed: observed.completed(), pageDigestRestarts };
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
      const changed = sync.itemsChanged > 0 || sync.itemsTombstoned > 0;
      const warnings = [...new Set([
        ...sync.gaps,
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
          items_indexed: sync.itemsIndexed,
          items_changed: sync.itemsChanged,
          items_tombstoned: sync.itemsTombstoned,
          deleted_events_applied: sync.deletedEventItemsTombstoned ?? 0,
          items_rejected: sync.itemsRejected,
          items_excluded: sync.itemsExcluded,
          metadata_only_items: sync.itemsMetadataOnly,
          traversal_complete: Number(run.completed),
          resumed_from_checkpoint: Number(resumed),
          page_digest_restarts: run.pageDigestRestarts,
          resume_cursor_reset: Number(cursorReset),
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
        checkpoint: sync.cursor ?? null,
      };
    },

    lastStoreRunCompletedAt: () => options.store.status().lastSyncRun?.completedAt,
  };
}

export function dropboxConnectorIdForScope(account: string, approvedScopeKey: string): string {
  const normalizedAccount = required(account, 'Dropbox connector account');
  const normalizedScope = required(approvedScopeKey, 'Dropbox approved scope key');
  const scopeHash = createHash('sha256')
    .update(`${normalizedAccount}\u0000${normalizedScope}`)
    .digest('hex')
    .slice(0, 24);
  return `dropbox.files.${scopeHash}`;
}

interface DropboxTraversalRun {
  sync: Awaited<ReturnType<LocalConnectorStore['syncFromConnector']>>;
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
      classify: (item) => connector.classify(item),
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
