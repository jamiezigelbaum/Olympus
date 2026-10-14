// Upgrade repair: ledger identities are the work list, never scans of item rows.
import { copyServingLayer, trustDomainRank, tierLedgerIdentityKey, type TierLedgerIdentity } from '../classification/tier-ledger.ts';
import { resolveEmbeddingLedgerPath } from '../embedding-ledger.ts';
import { resumeVerifiedTierMove, type TierMoveOptions } from './tier-move.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

const CURSOR = 'lower-content-purge-cursor-v2';
const DONE = 'lower-content-purge-done-v2';
const FAILED = 'lower-content-purge-failed-v2';
const VERIFIED = 'tier-move-verified:';
const RECEIPT_CURSOR = 'lower-content-purge-receipt-cursor-v2';
export const LOWER_CONTENT_PURGE_BATCH = 200;

/** One bounded startup/maintenance page. Completed upgrades persistently idle. */
export function purgeLowerTierContent(set: TieredStoreSet, options: {
  limit?: number;
  /** Production maintenance honors the completed upgrade watermark. */
  maintenance?: boolean;
  embeddingLedger?: TierMoveOptions['embeddingLedger'];
  /** @internal Race injection before the authoritative generation fence. */
  beforeDelete?: () => void;
  log?: (corpus: string, copies: number, chunks: number) => void;
} = {}): { checked: number; purged: number; resumed: number; failed: number } {
  const report = { checked: 0, purged: 0, resumed: 0, failed: 0 };
  const limit = Math.max(1, Math.min(options.limit ?? LOWER_CONTENT_PURGE_BATCH, LOWER_CONTENT_PURGE_BATCH));
  const note = options.embeddingLedger ?? { path: resolveEmbeddingLedgerPath(), approvedBy: 'system-automatic' as const };
  // Interrupted NEW moves are obligations even after the historical sweep is done.
  const resumed = new Set<string>();
  // Reserve half the page for historical repair, and rotate failures instead
  // of letting the first unavailable destinations starve every later receipt.
  const receiptBudget = Math.max(1, Math.floor(limit / 2));
  const receiptAfter = set.ledger.readMeta(RECEIPT_CURSOR) || undefined;
  let receipts = set.ledger.metaEntries(VERIFIED, { ...(receiptAfter ? { after: receiptAfter } : {}), limit: receiptBudget });
  if (!receipts.length && receiptAfter) receipts = set.ledger.metaEntries(VERIFIED, { limit: receiptBudget });
  for (const { key } of receipts) {
    const [provider, accountScope, conversation, providerItemId] = key.slice(VERIFIED.length).split('\0');
    if (!provider || !accountScope || !providerItemId) continue;
    const identity = { provider, accountScope, providerItemId, ...(conversation ? { providerConversationId: conversation } : {}) };
    report.checked++;
    try {
      if (resumeVerifiedTierMove(set, identity, note)) report.resumed++;
      resumed.add(tierLedgerIdentityKey(identity));
    } catch { report.failed++; }
  }
  set.ledger.writeMeta(RECEIPT_CURSOR, receipts.at(-1)?.key ?? '');
  if (options.maintenance && set.ledger.readMeta(DONE) === '1') return report;
  const raw = set.ledger.readMeta(CURSOR);
  const after = raw ? JSON.parse(raw) as TierLedgerIdentity : undefined;
  const stores = (['public_safe', 'internal'] as const).flatMap(domain => {
    const store = set.store(domain);
    return store ? [{ corpusId: store.corpusId, dbPath: store.dbPath, trustDomain: domain }] : [];
  });
  const page = set.ledger.listLowerContentLeftovers({ stores,
    ...(after ? { after } : {}), limit: Math.max(1, limit - report.checked) });
  const counts = new Map<string, { copies: number; chunks: number }>();
  const remaining = Math.max(0, limit - report.checked);
  for (const record of page.slice(0, remaining)) {
    const identity: TierLedgerIdentity = {
      provider: record.provider, accountScope: record.accountScope, providerItemId: record.providerItemId,
      ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
    };
    report.checked++;
    try {
      if (record.state === 'moving' || resumed.has(tierLedgerIdentityKey(identity))) continue;
      // Secrets keeps its own retirement policy and retry obligations.
      if (record.contentTier === 'secrets' || record.metadataTier === 'secrets') continue;
      const copies = set.ledger.copies(identity);
      const content = copyServingLayer(copies.filter(copy => copy.state === 'current'), 'content');
      const metadata = copyServingLayer(copies.filter(copy => copy.state === 'current'), 'metadata');
      // Metadata-only placements cannot prove a body reached a destination.
      if (!content) continue;
      const lower = copies.filter(copy => trustDomainRank(copy.trustDomain) < trustDomainRank(content.trustDomain));
      if (!lower.length) continue;
      const destination = set.store(content.trustDomain);
      if (!destination || destination.tierSetBinding()?.ledgerId !== set.ledger.ledgerId()) throw new Error('Destination unavailable.');
      destination.withItemCopyWriteFence(identity, () => {
        // Query counts/version state once, under the destination lock. Never
        // hold the ledger writer across exports or store-content proof reads.
        const proof = destination.copyContentState(identity);
        for (const copy of lower) {
          const store = set.store(copy.trustDomain);
          if (!store || store.tierSetBinding()?.ledgerId !== set.ledger.ledgerId()) throw new Error('Lower store unavailable.');
          store.withItemCopyWriteFence(identity, () => {
            const held = store.copyContentState(identity);
            const keepMetadata = !!metadata && trustDomainRank(copy.trustDomain) >= trustDomainRank(metadata.trustDomain);
            const hasBody = !!held && held.chunks + held.vectors + held.versions > 0;
            if (!held || (!hasBody && (keepMetadata || !held.names))) return;
            // A destination row alone is not a content receipt. Stale text or
            // an empty destination cannot authorize destruction of a body.
            if (hasBody && (!proof || proof.chunks === 0 || !proof.currentText)) throw new Error('Destination content is missing or stale.');
            if (!proof) throw new Error('Destination disappeared.');
            options.beforeDelete?.();
            set.ledger.withGenerationFence(identity, record.generation, () => {
              const current = set.ledger.getCurrent(identity)!;
              if (current.state === 'moving') throw new Error('Placement changed.');
              const chunks = store.stripCopyContent(identity, { keepMetadata });
              set.ledger.writeMeta(`tier-content-purged:${tierLedgerIdentityKey(identity)}`, String(current.generation));
              const entryId = `tier-content-repair:${set.ledger.ledgerId()}:${tierLedgerIdentityKey(identity)}:${current.generation}:${copy.corpusId}`;
              set.ledger.writeMeta(`tier-move-note:${entryId}`, JSON.stringify({ path: note.path, entry: {
                entry_id: entryId, recorded_at: new Date().toISOString(), kind: 'note',
                what: `Verified current content in ${content.corpusId}; removed ${chunks} lower-tier chunk(s), their vectors and text-version remnants from ${copy.corpusId}.`,
                scope: { corpora: [content.corpusId, copy.corpusId], chunks: { [copy.corpusId]: chunks } },
                approved_by: note.approvedBy, ...(note.why ? { why: note.why } : {}), status: 'complete',
              } }));
              report.purged++;
              const count = counts.get(copy.corpusId) ?? { copies: 0, chunks: 0 };
              count.copies++; count.chunks += chunks;
              counts.set(copy.corpusId, count);
            });
          });
        }
      });
    } catch { report.failed++; }
  }
  if (report.failed) set.ledger.writeMeta(FAILED, '1');
  if (remaining > 0) {
    const last = page.at(-1);
    const finished = page.length < remaining || !last;
    set.ledger.writeMeta(CURSOR, finished ? '' : JSON.stringify({
      provider: last.provider, accountScope: last.accountScope, providerItemId: last.providerItemId,
      ...(last.conversationKey ? { providerConversationId: last.conversationKey } : {}),
    }));
    if (finished) {
      set.ledger.writeMeta(DONE, set.ledger.readMeta(FAILED) === '1' ? '' : '1');
      set.ledger.writeMeta(FAILED, '');
    }
  }
  for (const [corpus, count] of counts) options.log?.(corpus, count.copies, count.chunks);
  return report;
}
