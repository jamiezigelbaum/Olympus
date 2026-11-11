// One-time upgrade cleanup for automatic moves made before source pruning.
// Migration rollback copies and Secrets retirement keep their own policies.
import { copyServingLayer, tierLedgerIdentityKey, trustDomainRank, type TierLedgerIdentity } from '../classification/tier-ledger.ts';
import { resolveEmbeddingLedgerPath } from '../embedding-ledger.ts';
import { pruneSupersededStoreCopy, queueTierLedgerEntry, type TierMoveOptions } from './tier-move.ts';
import { compareContentVersions } from './tier-content-purge.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

const STATE = 'automatic-superseded-prune-v1';
const PAGE_SIZE = 200;
interface Pending {
  identity: TierLedgerIdentity;
  generation: number;
  copies: Array<{ corpusId: string; chunks: number }>;
  embeddingLedger: NonNullable<TierMoveOptions['embeddingLedger']>;
}
interface State {
  done?: boolean;
  after?: TierLedgerIdentity;
  pending?: Pending;
  retry?: boolean;
  deleted?: Record<string, number>;
  embeddingLedger?: NonNullable<TierMoveOptions['embeddingLedger']>;
}

/** One bounded page at worker startup/maintenance; a failed item resumes first. */
export function sweepAutomaticSupersededCopies(set: TieredStoreSet, options: {
  limit?: number;
  embeddingLedger?: TierMoveOptions['embeddingLedger'];
} = {}): { checked: number; purged: number; kept: number; failed: number; complete: boolean } {
  const ledger = set.ledger;
  const state: State = JSON.parse(ledger.readMeta(STATE) || '{}');
  const report = { checked: 0, purged: 0, kept: 0, failed: 0, complete: state.done === true };
  if (state.done) return report;
  state.embeddingLedger ??= state.pending?.embeddingLedger ?? options.embeddingLedger
    ?? { path: resolveEmbeddingLedgerPath(), approvedBy: 'system-automatic' };
  const limit = Math.max(1, Math.min(options.limit ?? PAGE_SIZE, PAGE_SIZE));
  const save = () => ledger.writeMeta(STATE, JSON.stringify(state));
  const finishPending = (): void => {
    const pending = state.pending!;
    ledger.withGenerationFence(pending.identity, pending.generation, () => {
      const current = ledger.getCurrent(pending.identity)!;
      if (current.state === 'moving' || ledger.hasMovedMigrationProposal(pending.identity)) throw new Error('Placement or migration changed; retry cleanup later.');
      for (const target of pending.copies) {
        const copy = ledger.copies(pending.identity).find(copy => copy.corpusId === target.corpusId);
        if (copy?.state !== 'superseded') continue;
        const store = set.store(copy.trustDomain);
        if (!store) throw new Error('Superseded store unavailable.');
        store.bindTierSet(ledger);
        // The receipt's original count survives a death after this separate
        // store commit but before the ledger transaction below commits.
        pruneSupersededStoreCopy(store, pending.identity);
        ledger.removeSupersededCopy(pending.identity, copy.corpusId);
        const deleted = state.deleted ??= {};
        deleted[copy.corpusId] = (deleted[copy.corpusId] ?? 0) + target.chunks;
        report.purged++;
      }
      state.after = pending.identity;
      delete state.pending;
      save();
    });
  };
  try {
    if (state.pending) {
      report.checked++;
      const current = ledger.getCurrent(state.pending.identity);
      if (!current || current.generation !== state.pending.generation) {
        // A newer decision owns these copies. Never delete using stale proof.
        state.retry = true;
        state.after = state.pending.identity;
        delete state.pending;
        save();
      } else finishPending();
    }
    if (report.checked === limit) return report;
    const rows = ledger.listItemWindow({ ...(state.after ? { after: state.after } : {}), limit: limit - report.checked });
    for (const record of rows.slice(0, limit - report.checked)) {
      report.checked++;
      const identity: TierLedgerIdentity = { provider: record.provider, accountScope: record.accountScope,
        providerItemId: record.providerItemId, ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}) };
      ledger.withGenerationFence(identity, record.generation, () => {
        const now = ledger.getCurrent(identity)!;
        if (!now.routed || now.contentTier === 'secrets' || now.metadataTier === 'secrets'
          || ledger.hasMovedMigrationProposal(identity)) return;
        const copies = ledger.copies(identity);
        if (!copies.some(copy => copy.state === 'superseded')) return;
        // A hide-first move can own superseded sources before its flip. Walk
        // again once the page sequence ends; never mark these items done yet.
        if (now.state === 'moving') { state.retry = true; return; }
        const content = copyServingLayer(copies.filter(copy => copy.state === 'current'), 'content');
        // A names-only placement cannot prove a body reached a destination.
        if (!content) return;
        // Only copies a LOWERING left behind, in a store above the one that now
        // serves the content. A raise keeps its names-only superseded row.
        const superseded = copies.filter(copy => copy.state === 'superseded'
          && trustDomainRank(copy.trustDomain) > trustDomainRank(content.trustDomain));
        if (!superseded.length) return;
        const destination = content && set.store(content.trustDomain);
        const proof = destination?.copyContentState(identity);
        if (!proof || destination?.tierSetBinding()?.ledgerId !== ledger.ledgerId()) throw new Error('Current destination unavailable.');
        let unproven = false;
        const targets = superseded.map(copy => {
          const store = set.store(copy.trustDomain);
          if (!store) throw new Error('Superseded store unavailable.');
          store.bindTierSet(ledger);
          const held = store.copyContentState(identity);
          const chunks = held?.chunks ?? 0;
          if (chunks && (!proof.chunks || !proof.currentText)) throw new Error('Current destination has no verified body.');
          // A historical copy may hold a newer source version than the
          // destination. Prune only what the destination is proven at least
          // as fresh as; otherwise keep every copy of this item.
          if (held && chunks) {
            const order = compareContentVersions(proof, held);
            if (order === undefined || order < 0) unproven = true;
          }
          return { corpusId: copy.corpusId, chunks };
        });
        if (unproven) { report.kept++; return; }
        state.pending = { identity, generation: record.generation, copies: targets,
          embeddingLedger: state.embeddingLedger! };
        // Commit the receipt and rollback refusal BEFORE any store is stripped.
        ledger.writeMeta(`tier-content-purged:${tierLedgerIdentityKey(identity)}`, String(record.generation));
        save();
      });
      if (state.pending) finishPending();
      else { state.after = identity; save(); }
    }
    if (report.checked < limit) {
      if (state.retry) { delete state.after; delete state.retry; save(); }
      else {
        // Totals and the completion watermark commit with one durable audit
        // obligation per corpus. Page boundaries and crashes cannot duplicate it.
        ledger.withMoveBatch(() => {
          const config = state.embeddingLedger!;
          for (const [corpusId, chunks] of Object.entries(state.deleted ?? {})) {
            queueTierLedgerEntry(ledger, config.path, {
              entry_id: `automatic-superseded-prune:${ledger.ledgerId()}:${corpusId}`,
              recorded_at: new Date().toISOString(), kind: 'invalidation',
              what: `Pruned superseded automatic tier-move copies: ${chunks} kept chunk(s), their full-text content and vectors removed.`,
              scope: { corpora: [corpusId], chunks: { [corpusId]: chunks } },
              approved_by: config.approvedBy, status: 'complete',
            });
          }
          state.done = true;
          save();
        });
        report.complete = true;
      }
    }
  } catch {
    // Cursor stays before the failed item; its original counts stay durable.
    report.failed++;
    report.complete = false;
  }
  return report;
}
