// Upgrade repair: ledger identities are the work list, never scans of item rows.
import { copyServingLayer, trustDomainRank, tierLedgerIdentityKey, type TierLedgerIdentity } from '../classification/tier-ledger.ts';
import { resumeVerifiedTierMove } from './tier-move.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

const CURSOR = 'lower-content-purge-cursor-v1';
export const LOWER_CONTENT_PURGE_BATCH = 200;

/** One bounded rotating page, at startup and every maintenance/sync pass. */
export function purgeLowerTierContent(set: TieredStoreSet, options: {
  limit?: number;
  /** @internal Race injection before the authoritative generation fence. */
  beforeDelete?: () => void;
  log?: (corpus: string, copies: number, chunks: number) => void;
} = {}): { checked: number; purged: number; resumed: number; failed: number } {
  const report = { checked: 0, purged: 0, resumed: 0, failed: 0 };
  const raw = set.ledger.readMeta(CURSOR);
  const after = raw ? JSON.parse(raw) as TierLedgerIdentity : undefined;
  const limit = Math.max(1, Math.min(options.limit ?? LOWER_CONTENT_PURGE_BATCH, LOWER_CONTENT_PURGE_BATCH));
  const page = set.ledger.listRouted({ ...(after ? { after } : {}), limit });
  const counts = new Map<string, { copies: number; chunks: number }>();
  for (const record of page) {
    const identity: TierLedgerIdentity = {
      provider: record.provider, accountScope: record.accountScope, providerItemId: record.providerItemId,
      ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
    };
    report.checked++;
    try {
      if (record.state === 'moving') {
        if (resumeVerifiedTierMove(set, identity)) report.resumed++;
        continue;
      }
      // Secrets keeps its own retirement policy and retry obligations.
      if (record.contentTier === 'secrets' || record.metadataTier === 'secrets') continue;
      options.beforeDelete?.();
      set.ledger.withGenerationFence(identity, record.generation, () => {
        const current = set.ledger.getCurrent(identity)!;
        if (current.state === 'moving') return;
        const copies = set.ledger.copies(identity);
        const content = copyServingLayer(copies.filter(copy => copy.state === 'current'), 'content')
          ?? copyServingLayer(set.placementFor({
            metadataTier: current.metadataTier, contentTier: current.contentTier, state: 'current',
            metadataPending: false, contentPending: false, contentRead: true,
            ...(current.decidedBy === 'override' ? { decidedBy: 'override' as const } : {}),
          }).copies, 'content');
        const metadata = copyServingLayer(copies.filter(copy => copy.state === 'current'), 'metadata');
        if (!content) return;
        const destination = set.store(content.trustDomain);
        // Do not destroy a rollback source unless the current destination exists.
        if (!destination || destination.tierSetBinding()?.ledgerId !== set.ledger.ledgerId()
          || !destination.exportItemCopy(identity)) return;
        for (const copy of copies) {
          if (trustDomainRank(copy.trustDomain) >= trustDomainRank(content.trustDomain)) continue;
          const store = set.store(copy.trustDomain);
          if (!store || store.tierSetBinding()?.ledgerId !== set.ledger.ledgerId()) continue;
          const chunks = destination.withItemCopyWriteFence(identity, () => {
            if (!destination.exportItemCopy(identity)) throw new Error('Current destination disappeared.');
            return store.stripCopyContent(identity, { keepMetadata: !!metadata
              && trustDomainRank(copy.trustDomain) >= trustDomainRank(metadata.trustDomain) });
          });
          set.ledger.writeMeta(`tier-content-purged:${tierLedgerIdentityKey(identity)}`, String(current.generation));
          report.purged++;
          const count = counts.get(copy.corpusId) ?? { copies: 0, chunks: 0 };
          count.copies++; count.chunks += chunks;
          counts.set(copy.corpusId, count);
        }
      });
    } catch {
      // An unavailable store or changed generation is retried next rotation.
      report.failed++;
    }
  }
  const last = page.at(-1);
  set.ledger.writeMeta(CURSOR, page.length < limit || !last ? '' : JSON.stringify({
    provider: last.provider, accountScope: last.accountScope, providerItemId: last.providerItemId,
    ...(last.conversationKey ? { providerConversationId: last.conversationKey } : {}),
  }));
  for (const [corpus, count] of counts) {
    options.log?.(corpus, count.copies, count.chunks);
  }
  return report;
}
