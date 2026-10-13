// What happens to an item's stored copies once it is judged Secrets (design
// docs/design/per-item-four-tier-classification.md, sections 2.3 and 4.2).
//
// THE ONE PLACE this is decided. Every path that turns an item into Secrets
// reads it: the sync's router (tiered-store-set.ts), the extraction landing
// sink (file-extraction/tiered-store-sink.ts), the move primitive
// (tier-move.ts) and the tier migration (classification/tier-migration.ts).
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
//
// Either way, too, the side stores that hold the item's names or a short
// excerpt outside its store copies keep none of it (`forgetSecretInSideStores`):
// the sniffer's queued questions (beside the set ledger) are deleted, and the
// extraction job ledger's captured names are cleared, for good (a later
// enqueue cannot write them back). A Secret keeps its
// location only, wherever it was written down (docs/TRUST_MODEL.md).

import { existsSync } from 'node:fs';
import type { SourceItemIdentity, SourceTrustTier } from '../../core/source-index/types.ts';
import { TierSnifferStore } from '../classification/sniffer-store.ts';
import type { TierCopy, TierLedger, TierLedgerIdentity } from '../classification/tier-ledger.ts';
import { tierSnifferPathForLedger } from '../classification/tier-ledger-path.ts';
import { clearExtractionJobNames, extractionJobsDbPaths } from '../file-extraction/job-names.ts';
import type { LocalConnectorStore } from './local-index.ts';

export type SecretsDisposition = 'tombstone_now' | 'hide_until_purge';

export const SECRETS_DISPOSITION: SecretsDisposition = 'tombstone_now';

export function secretsDisposition(): SecretsDisposition {
  return SECRETS_DISPOSITION;
}

export interface SettledSecretsCopies {
  disposition: SecretsDisposition;
  /** Chunks deleted per corpus (tombstone_now), or kept hidden per corpus (hide_until_purge). */
  chunks: Record<string, number>;
  sideStores: ForgottenSecretSideStores;
}

export interface ForgottenSecretSideStores {
  /** Queued sniffer questions deleted (both passes). */
  snifferQuestions: number;
  /** Extraction job rows whose captured name was cleared. */
  extractionJobNames: number;
  /** Side stores that could not be reached; left as a ledger debt, retried every tier tick. */
  failed: number;
  /** Job ledgers cleared but not yet able to keep the names out (an older schema); also owed. */
  notDurable: number;
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
  // Whichever way the copies go, the side stores forget the item now.
  const sideStores = forgetSecretInSideStores({ ledger: options.ledger, identity });
  if (disposition === 'tombstone_now') options.ledger.removeCopies(options.identity);
  return { disposition, chunks, sideStores };
}

/**
 * Forget a Secrets item in the side stores that hold its names or a short
 * excerpt: delete its queued sniffer questions (the file beside `ledger`) and
 * clear the names its extraction jobs captured, for good. Files that do not
 * exist are not created. Never throws (the copies' fate must not wait on a
 * side file): a store that cannot be reached is logged and left as a debt in
 * the ledger, which `retrySecretSideStoreDebts` clears at the next tier tick.
 */
export function forgetSecretInSideStores(options: {
  ledger: TierLedger;
  identity: TierLedgerIdentity & { localItemId?: string };
  /** Job ledgers an earlier attempt owed, beyond the ones this process knows. */
  jobLedgerPaths?: readonly string[];
  /**
   * Called outside the worker (the `tier set` command): the extraction
   * runtime may keep its job ledger at a path only its own process knows, so
   * the item stays owed until the worker's next tier tick repeats this there.
   */
  confirmInWorker?: boolean;
}): ForgottenSecretSideStores {
  const result: ForgottenSecretSideStores = { snifferQuestions: 0, extractionJobNames: 0, failed: 0, notDurable: 0 };
  const { identity, ledger } = options;
  const owedJobLedgers: string[] = [];
  const snifferPath = tierSnifferPathForLedger(ledger.dbPath);
  if (snifferPath !== ':memory:' && existsSync(snifferPath)) {
    try {
      const sniffer = new TierSnifferStore({ dbPath: snifferPath });
      try {
        result.snifferQuestions = sniffer.deleteItemQuestions({
          provider: identity.provider,
          accountScope: identity.accountScope,
          providerItemId: identity.providerItemId,
          ...(identity.providerConversationId ? { providerConversationId: identity.providerConversationId } : {}),
        });
      } finally {
        sniffer.close();
      }
    } catch {
      result.failed += 1;
    }
  }
  // The default ledger, any other this process opened (a runtime given its
  // own path), and any an earlier attempt still owes.
  for (const jobsPath of new Set([...extractionJobsDbPaths(), ...(options.jobLedgerPaths ?? [])])) {
    try {
      const cleared = clearExtractionJobNames(jobsPath, {
        provider: identity.provider,
        accountScope: identity.accountScope,
        providerItemId: identity.providerItemId,
        ...(identity.localItemId ? { localItemId: identity.localItemId } : {}),
      });
      result.extractionJobNames += cleared.cleared;
      if (!cleared.durable) {
        result.notDurable += 1;
        owedJobLedgers.push(jobsPath);
      }
    } catch {
      result.failed += 1;
      owedJobLedgers.push(jobsPath);
    }
  }
  try {
    if (result.failed > 0 || result.notDurable > 0 || options.confirmInWorker) ledger.recordSecretSideStoreDebt(identity, owedJobLedgers);
    else ledger.clearSecretSideStoreDebt(identity);
  } catch {
    // The ledger itself unreachable: the copies' own settlement fails loudly elsewhere.
  }
  if (result.failed > 0) console.warn(`[tier] secrets: ${result.failed} side store(s) could not forget an item; retried at the next tier tick.`);
  return result;
}

/** Retry the side-store clearing of Secrets that could not be cleared before. Returns how many are now clear. */
export function retrySecretSideStoreDebts(ledger: TierLedger, limit = 100): number {
  let cleared = 0;
  for (const identity of ledger.secretSideStoreDebts(limit)) {
    const { jobLedgerPaths, ...item } = identity;
    const result = forgetSecretInSideStores({ ledger, identity: item, jobLedgerPaths });
    if (result.failed === 0 && result.notDurable === 0) cleared += 1;
  }
  return cleared;
}
