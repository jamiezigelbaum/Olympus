// What happens to an item's stored copies once it is judged Secrets (design
// docs/design/per-item-four-tier-classification.md, sections 2.3 and 4.2).
//
// THE ONE PLACE this is decided. Every path that turns an item into Secrets
// reads it: the sync's router (tiered-store-set.ts), the extraction landing
// sinks (file-extraction/tiered-store-sink.ts and, for a store no ledger
// tracks, file-extraction/store-sink.ts), the move primitive (tier-move.ts)
// and the tier migration (classification/tier-migration.ts).
//
// - `tombstone_now` (today's behavior, design section 4.2 "Mandatory"): every
//   copy is tombstoned at once — chunks, FTS rows and vectors deleted — and
//   only the location is kept.
// - `hide_until_purge`: every copy is hidden (superseded in the tier ledger,
//   never searched, served, counted or embedded) and KEPT until the owner
//   approves a purge (`olympus tier migrate purge`).
//
// Either way the item is hidden in the same ledger write before anything else
// happens, and its location is recorded. The owner's choice between the two
// is pending; switching is this one constant.

import type { SourceItemIdentity, SourceTrustTier } from '../../core/source-index/types.ts';
import type { TierCopy, TierLedger, TierLedgerIdentity } from '../classification/tier-ledger.ts';
import type { ConnectorStoreItemWriteClaim, ConnectorStoreOwnershipKind, LocalConnectorStore } from './local-index.ts';

export type SecretsDisposition = 'tombstone_now' | 'hide_until_purge';

export const SECRETS_DISPOSITION: SecretsDisposition = 'tombstone_now';

export function secretsDisposition(): SecretsDisposition {
  return SECRETS_DISPOSITION;
}

export interface SettledSecretsCopies {
  disposition: SecretsDisposition;
  /** Chunks deleted per corpus (tombstone_now), or kept hidden per corpus (hide_until_purge). */
  chunks: Record<string, number>;
}

/**
 * Apply the policy to a Secrets item whose copies the ledger has ALREADY
 * hidden (superseded): tombstone each store copy and forget the copy rows, or
 * leave them hidden and kept. Returns what it did, per corpus, counts only.
 */
export function settleSecretsCopies(options: {
  ledger: TierLedger;
  identity: TierLedgerIdentity & Pick<SourceItemIdentity, 'family' | 'localItemId'>;
  copies: readonly TierCopy[];
  storeFor: (corpusId: string) => LocalConnectorStore | undefined;
  connectorId: string;
  disposition?: SecretsDisposition;
}): SettledSecretsCopies {
  const disposition = options.disposition ?? secretsDisposition();
  const chunks: Record<string, number> = {};
  const identity: SourceItemIdentity = {
    family: options.identity.family ?? 'file',
    provider: options.identity.provider,
    accountScope: options.identity.accountScope,
    providerItemId: options.identity.providerItemId,
    localItemId: options.identity.localItemId,
    ...(options.identity.providerConversationId ? { providerConversationId: options.identity.providerConversationId } : {}),
  };
  for (const copy of options.copies) {
    const store = options.storeFor(copy.corpusId);
    if (!store) continue;
    chunks[copy.corpusId] = (chunks[copy.corpusId] ?? 0) + (store.itemStoredContent(identity)?.chunkCount ?? 0);
    if (disposition === 'tombstone_now') {
      const trustTier: SourceTrustTier = 'S5';
      store.tombstoneCopy(identity, { connectorId: options.connectorId, trustTier });
    }
  }
  if (disposition === 'tombstone_now') options.ledger.removeCopies(options.identity);
  return { disposition, chunks };
}

/**
 * Apply the policy to a Secrets item in a store no tier ledger tracks a copy
 * for (a plain store, or a tiered set's legacy leg holding an unrouted item).
 * Hiding is a ledger copy row, and such a copy has none, so under either
 * disposition it cannot be kept hidden: it is tombstoned and keeps its
 * location only, exactly as the store's own sync treats an S5 item. The
 * store fences the tombstone like the write it replaces (owner skip, claim
 * generation) and says which way it went.
 */
export function settleUntrackedSecretsCopy(options: {
  store: LocalConnectorStore;
  identity: SourceItemIdentity;
  connectorId: string;
  skipOwner?: { connectorId: string; ownershipKind: ConnectorStoreOwnershipKind };
  writeClaim?: ConnectorStoreItemWriteClaim;
}): ReturnType<LocalConnectorStore['tombstoneSecretsExtraction']> {
  return options.store.tombstoneSecretsExtraction(options.identity, {
    connectorId: options.connectorId,
    ...(options.skipOwner ? { skipOwner: options.skipOwner } : {}),
    ...(options.writeClaim ? { writeClaim: options.writeClaim } : {}),
  });
}
