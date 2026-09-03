import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import type { RawItem } from '../../core/contracts.ts';
import { buildSourceSensitivity } from '../../core/source-index/types.ts';
import {
  CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS,
  LocalConnectorStore,
  connectorStoreChunkText,
  connectorStoreHashString,
  type ConnectorStoreExtractionCandidate,
  type ConnectorStoreRepresentationRestoreItem,
} from '../connector-store/index.ts';
import {
  createEnvCredentialBroker,
  requireBearerTokenCredentialSession,
  type CredentialBroker,
} from '../credential-broker/index.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import {
  XApiClient,
  XApiError,
  xBookmarkPostResourceIds,
  type XBookmarkPost,
  type XBookmarkPostLookupResult,
  type XBookmarksFetch,
} from './api.ts';
import {
  X_BOOKMARKS_LIVE_CONNECTOR_ID,
  X_BOOKMARKS_PROVIDER,
  xBookmarkRawItemFromPost,
} from './connector.ts';
import { X_BOOKMARKS_FOLDER_FACET_AUTHORITY_VERSION } from './folder-facets.ts';
import {
  LocalXBookmarksApiUsageStore,
  XApiUsageGuardError,
  defaultXBookmarksLiveSyncConfig,
  type XBookmarksLiveSyncConfig,
} from './live-control.ts';
import type { LocalXBookmarksReconcileStateStore } from './reconcile-state.ts';
import type { XBookmarksFolderFacetRefreshAuthority } from './reconcile-state.ts';

const RECOVERY_CONNECTOR_ID = 'x_bookmarks_content_recovery';
const MAX_RECOVERY_ITEMS = 100;

export interface XBookmarksContentRecoveryRequest {
  execute?: boolean;
  limit?: number;
}

export interface XBookmarksContentRecoveryCounts {
  candidates_scanned: number;
  candidates_with_post_url: number;
  candidates_without_recoverable_url: number;
  api_requests: number;
  provider_items_requested: number;
  provider_items_returned: number;
  items_recovered: number;
  items_unchanged_at_execute: number;
  items_skipped_by_policy: number;
  items_unrecoverable: number;
  items_deferred: number;
  chunks_awaiting_embedding: number;
  chunks_embedded: number;
  provider_failures: number;
}

export interface XBookmarksContentRecoveryReceipt {
  kind: 'x_bookmarks_content_recovery_receipt';
  status: 'planned' | 'completed' | 'nothing_to_recover' | 'deferred' | 'failed';
  counts: XBookmarksContentRecoveryCounts;
  retry_at?: string;
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    resource_ids_exposed: false;
  };
  receipt_sha256: string;
}

export interface XBookmarkContentLookupClient {
  fetchPostsByIds(postIds: readonly string[]): Promise<XBookmarkPostLookupResult>;
}

export interface XBookmarksContentRecoveryHandler {
  recover(request?: XBookmarksContentRecoveryRequest): Promise<XBookmarksContentRecoveryReceipt>;
}

export interface XBookmarksContentRecoveryOptions {
  store: LocalConnectorStore;
  usageStore: LocalXBookmarksApiUsageStore;
  reconcileStateStore?: LocalXBookmarksReconcileStateStore;
  embeddingProvider?: SourceEmbeddingProvider;
  account: string;
  userId: string;
  credentialHandle?: string;
  credentialBroker?: CredentialBroker;
  sourceClient?: XBookmarkContentLookupClient;
  config?: XBookmarksLiveSyncConfig;
  fetch?: XBookmarksFetch;
  apiBaseUrl?: string;
  timeoutMs?: number;
  receiptPath?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export function createXBookmarksContentRecoveryHandler(
  options: XBookmarksContentRecoveryOptions,
): XBookmarksContentRecoveryHandler {
  const account = requireNonEmpty(options.account, 'X bookmark content-recovery account');
  const userId = requireNonEmpty(options.userId, 'X bookmark content-recovery provider user id');
  const env = options.env ?? process.env;
  const config = options.config ?? defaultXBookmarksLiveSyncConfig(env);
  const credentialHandle = options.credentialHandle?.trim()
    || env.OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CREDENTIAL_HANDLE?.trim()
    || 'x.bookmarks.personal';
  const broker = options.credentialBroker ?? createEnvCredentialBroker({
    env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const now = options.now ?? (() => new Date());
  const receiptPath = options.receiptPath
    ?? defaultXBookmarksContentRecoveryReceiptPath(options.store.dbPath);

  return {
    async recover(request: XBookmarksContentRecoveryRequest = {}) {
      const limit = recoveryLimit(request.limit);
      const candidates = options.store.extractionCandidates({
        limit,
        accountScope: account,
        withoutChunksOnly: true,
        mimeTypes: ['text/plain; charset=utf-8'],
      }).candidates;
      const recoverable = candidates.filter(isRecoverableXBookmarkCandidate);
      const counts = emptyCounts();
      counts.candidates_scanned = candidates.length;
      counts.candidates_with_post_url = recoverable.length;
      counts.candidates_without_recoverable_url = candidates.length - recoverable.length;

      if (request.execute !== true) {
        return buildReceipt(
          recoverable.length > 0 ? 'planned' : 'nothing_to_recover',
          counts,
        );
      }
      if (recoverable.length === 0) {
        return writeReceipt(receiptPath, buildReceipt('nothing_to_recover', counts));
      }
      const facetAuthorityAtGate = options.reconcileStateStore?.folderFacetRefreshAuthority({
        account,
        providerUserId: userId,
        algorithmVersion: X_BOOKMARKS_FOLDER_FACET_AUTHORITY_VERSION,
      });
      if (facetAuthorityAtGate?.status === 'running') {
        counts.items_deferred = recoverable.length;
        return writeReceipt(receiptPath, buildReceipt('deferred', counts));
      }

      const attemptedAt = validDate(now());
      const multiplier = config.richResourceExpansionMultiplier;
      let reservation;
      try {
        reservation = options.usageStore.reserveRequest({
          account,
          requestedMaxResources: recoverable.length * multiplier,
          minimumResources: multiplier,
          preserveHeadReserve: true,
          countApiRequestOnDispatch: true,
          config,
          now: attemptedAt,
        });
      } catch (error) {
        if (!(error instanceof XApiUsageGuardError)) throw error;
        counts.items_deferred = recoverable.length;
        return writeReceipt(receiptPath, buildReceipt('deferred', counts, error.retryAt));
      }

      const requestedCount = Math.min(
        recoverable.length,
        Math.floor(reservation.maxResources / multiplier),
      );
      const requestedCandidates = recoverable.slice(0, requestedCount);
      counts.items_deferred = recoverable.length - requestedCandidates.length;

      let client: XBookmarkContentLookupClient;
      try {
        client = options.sourceClient ?? await authenticatedClient({
          broker,
          credentialHandle,
          userId,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        });
      } catch {
        options.usageStore.cancelUndispatchedRequest({ reservation });
        counts.items_deferred += requestedCandidates.length;
        return writeReceipt(receiptPath, buildReceipt('failed', counts));
      }

      let lookup: XBookmarkPostLookupResult;
      let dispatched = false;
      let dispatchAt = attemptedAt;
      try {
        dispatchAt = validDate(now());
        options.usageStore.markRequestDispatched({
          reservation,
          config,
          preserveHeadReserve: true,
          now: dispatchAt,
        });
        dispatched = true;
        counts.api_requests = 1;
        counts.provider_items_requested = requestedCandidates.length;
        lookup = await client.fetchPostsByIds(
          requestedCandidates.map((candidate) => candidate.identity.providerItemId),
        );
        options.usageStore.settleSuccess({
          reservation,
          resourceIds: xBookmarkPostResourceIds(lookup.posts),
          ...(lookup.rateLimit ? { rateLimit: lookup.rateLimit } : {}),
          config,
          now: dispatchAt,
        });
      } catch (error) {
        if (!dispatched) {
          options.usageStore.cancelUndispatchedRequest({ reservation });
          counts.items_deferred += requestedCandidates.length;
          return writeReceipt(
            receiptPath,
            buildReceipt(
              error instanceof XApiUsageGuardError ? 'deferred' : 'failed',
              counts,
              error instanceof XApiUsageGuardError ? error.retryAt : undefined,
            ),
          );
        }
        const rateLimit = error instanceof XApiError ? error.rateLimit : undefined;
        options.usageStore.settleFailure({
          reservation,
          ...(rateLimit ? { rateLimit } : {}),
          potentiallyBillable: error instanceof XApiError && error.status === undefined,
          config,
          now: dispatchAt,
        });
        counts.provider_failures = 1;
        counts.items_deferred += requestedCandidates.length;
        const retryAt = recoveryRetryAt(error, config, dispatchAt);
        return writeReceipt(
          receiptPath,
          buildReceipt(retryAt ? 'deferred' : 'failed', counts, retryAt),
        );
      }

      counts.provider_items_returned = lookup.posts.length;
      const postsWithText = lookup.posts.filter((post) => Boolean(post.text?.trim()));
      counts.items_unrecoverable = lookup.unavailableCount + lookup.posts.length - postsWithText.length;

      if (postsWithText.length > 0) {
        const candidatesById = new Map(
          requestedCandidates.map((candidate) => [candidate.identity.providerItemId, candidate]),
        );
        const restoreItems = postsWithText.flatMap((post) => {
          const candidate = candidatesById.get(post.id);
          if (!candidate) return [];
          const item = recoveryRawItem(post, account, attemptedAt.toISOString());
          return [{
            item,
            expectation: {
              sourceItem: item.identity,
              ...(item.identity.sourceVersion ? { sourceVersion: item.identity.sourceVersion } : {}),
              contentHash: connectorStoreHashString(post.text!.trim()),
              chunkContentHashes: connectorStoreChunkText(
                post.text!.trim(),
                CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS,
              ).map(connectorStoreHashString),
            },
          }];
        });
        const facetAuthorityAtRestore =
          options.reconcileStateStore?.folderFacetRefreshAuthority({
            account,
            providerUserId: userId,
            algorithmVersion: X_BOOKMARKS_FOLDER_FACET_AUTHORITY_VERSION,
          });
        if (!sameFolderFacetAuthorityReading(
          facetAuthorityAtGate,
          facetAuthorityAtRestore,
        )) {
          counts.items_deferred += restoreItems.length;
          return writeReceipt(receiptPath, buildReceipt('deferred', counts));
        }
        const completedFacetAuthority = facetAuthorityAtRestore?.status === 'completed'
          ? facetAuthorityAtRestore
          : undefined;
        const restored = options.store.restoreItemRepresentations({
          items: restoreItems,
          syncConnectorId: RECOVERY_CONNECTOR_ID,
          ownerConnectorId: X_BOOKMARKS_LIVE_CONNECTOR_ID,
          ownershipKind: 'observed',
          preserveStoredSearchText: true,
          // Stored facet lines are preserved verbatim, whatever the refresh
          // state says. "No completed refresh run" is the ordinary state of a
          // store whose facets were always written by the current codec, so
          // reading it as "these lines are not mine" would escape genuine
          // facets — and this restore carries no folder list to re-emit them
          // from. Namespace sanitation of pre-codec rows belongs to
          // refreshOwnedSearchTextFacets, which covers the whole account;
          // doing it to whichever items happen to pass through recovery is not
          // a control, only collateral damage.
          preserveStoredSearchTextOwnedFacets: true,
          classify: () => buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'internal' }),
        });
        counts.items_recovered = restored.counts.itemsRestored;
        counts.items_unchanged_at_execute = restored.counts.itemsUnchanged;
        counts.items_skipped_by_policy =
          restored.counts.itemsExcluded + restored.counts.itemsMetadataOnly;
        counts.chunks_awaiting_embedding = restored.counts.chunksAwaitingEmbedding;

        if (options.embeddingProvider && restored.restoredProviderItemIds.length > 0) {
          const restoredIds = new Set(restored.restoredProviderItemIds);
          const localItemIds = restoreItems
            .filter((record) => restoredIds.has(record.item.identity.providerItemId))
            .map((record) => record.item.identity.localItemId);
          const embedded = await options.store.embedChunks({
            provider: options.embeddingProvider,
            localItemIds,
            ...(completedFacetAuthority && completedFacetAuthority.leaseGeneration > 0
              ? {
                  journalId: contentRecoveryEmbeddingJournalId(restoreItems),
                  journalLeaseGeneration: completedFacetAuthority.leaseGeneration,
                }
              : {}),
          });
          counts.chunks_embedded = embedded.chunksEmbedded;
          counts.chunks_awaiting_embedding = Math.max(
            0,
            counts.chunks_awaiting_embedding - embedded.chunksEmbedded,
          );
        }
      }

      return writeReceipt(receiptPath, buildReceipt('completed', counts));
    },
  };
}

function sameFolderFacetAuthorityReading(
  atGate: XBookmarksFolderFacetRefreshAuthority | undefined,
  atRestore: XBookmarksFolderFacetRefreshAuthority | undefined,
): boolean {
  if (!atGate || !atRestore) return atGate === atRestore;
  if (atGate.status !== atRestore.status) return false;
  if (atGate.status === 'unavailable' || atRestore.status === 'unavailable') return true;
  return atGate.leaseGeneration === atRestore.leaseGeneration;
}

function contentRecoveryEmbeddingJournalId(
  restoreItems: readonly ConnectorStoreRepresentationRestoreItem[],
): string {
  const inputSha256 = createHash('sha256')
    .update(JSON.stringify(restoreItems))
    .digest('hex');
  return `x_content_recovery:${inputSha256}:embeddings`;
}

export function defaultXBookmarksContentRecoveryReceiptPath(storePath: string): string {
  return resolve(`${storePath}.content-recovery-receipt.json`);
}

export function verifyXBookmarksContentRecoveryReceipt(
  receipt: XBookmarksContentRecoveryReceipt,
): void {
  const { receipt_sha256: digest, ...unsigned } = receipt;
  if (!/^[a-f0-9]{64}$/.test(digest) || digest !== sha256Json(unsigned)) {
    throw new Error('X bookmark content-recovery receipt self-digest mismatch.');
  }
  if (receipt.policy.counts_only !== true
    || receipt.policy.raw_source_exposed !== false
    || receipt.policy.source_text_returned !== false
    || receipt.policy.resource_ids_exposed !== false) {
    throw new Error('X bookmark content-recovery receipt policy is invalid.');
  }
}

async function authenticatedClient(input: {
  broker: CredentialBroker;
  credentialHandle: string;
  userId: string;
  fetch?: XBookmarksFetch;
  apiBaseUrl?: string;
  timeoutMs?: number;
}): Promise<XBookmarkContentLookupClient> {
  const session = requireBearerTokenCredentialSession(await input.broker.issueSession({
    handle: input.credentialHandle,
    provider: 'x',
    capability: 'x.bookmarks.sync',
    trustDomain: 'internal',
    purpose: 'Recover missing content for already-indexed X bookmarks.',
  }), input.credentialHandle);
  return new XApiClient({
    token: session.token,
    userId: input.userId,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.apiBaseUrl ? { baseUrl: input.apiBaseUrl } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
}

function recoveryRawItem(post: XBookmarkPost, account: string, fetchedAt: string): RawItem {
  const item = xBookmarkRawItemFromPost(post, account, [], fetchedAt);
  const text = post.text?.trim();
  if (!text) throw new Error('X bookmark content recovery cannot restore an empty post.');
  return {
    ...item,
    content: { kind: 'text', text },
    metadata: Object.freeze({
      ...item.metadata,
      contentHash: connectorStoreHashString(text),
    }),
  };
}

function isRecoverableXBookmarkCandidate(candidate: ConnectorStoreExtractionCandidate): boolean {
  return candidate.identity.provider === X_BOOKMARKS_PROVIDER
    && /^\d{1,32}$/.test(candidate.identity.providerItemId)
    && candidate.locatorUri === `https://x.com/i/web/status/${candidate.identity.providerItemId}`;
}

function recoveryRetryAt(
  error: unknown,
  config: XBookmarksLiveSyncConfig,
  now: Date,
): string | undefined {
  if (!(error instanceof XApiError)) return undefined;
  if (error.status === 429) {
    return error.rateLimit?.resetAt
      ?? new Date(now.getTime() + config.degradedIntervalMs).toISOString();
  }
  if (error.status === undefined || error.status >= 500) {
    return new Date(now.getTime() + config.degradedIntervalMs).toISOString();
  }
  return undefined;
}

function recoveryLimit(value: number | undefined): number {
  if (value === undefined) return 10;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECOVERY_ITEMS) {
    throw new TypeError(`X bookmark content recovery limit must be between 1 and ${MAX_RECOVERY_ITEMS}.`);
  }
  return value;
}

function emptyCounts(): XBookmarksContentRecoveryCounts {
  return {
    candidates_scanned: 0,
    candidates_with_post_url: 0,
    candidates_without_recoverable_url: 0,
    api_requests: 0,
    provider_items_requested: 0,
    provider_items_returned: 0,
    items_recovered: 0,
    items_unchanged_at_execute: 0,
    items_skipped_by_policy: 0,
    items_unrecoverable: 0,
    items_deferred: 0,
    chunks_awaiting_embedding: 0,
    chunks_embedded: 0,
    provider_failures: 0,
  };
}

function buildReceipt(
  status: XBookmarksContentRecoveryReceipt['status'],
  counts: XBookmarksContentRecoveryCounts,
  retryAt?: string,
): XBookmarksContentRecoveryReceipt {
  const unsigned = {
    kind: 'x_bookmarks_content_recovery_receipt' as const,
    status,
    counts,
    ...(retryAt ? { retry_at: retryAt } : {}),
    policy: {
      counts_only: true as const,
      raw_source_exposed: false as const,
      source_text_returned: false as const,
      resource_ids_exposed: false as const,
    },
  };
  return { ...unsigned, receipt_sha256: sha256Json(unsigned) };
}

function writeReceipt(
  pathValue: string,
  receipt: XBookmarksContentRecoveryReceipt,
): XBookmarksContentRecoveryReceipt {
  const path = resolve(pathValue);
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return receipt;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1_000) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return normalized;
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new TypeError('X bookmark content-recovery time is invalid.');
  return value;
}
