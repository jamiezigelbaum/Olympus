// One-time upgrade cleanup for automatic moves made before source pruning.
// Migration rollback copies and Secrets retirement keep their own policies.
import { copyServingLayer, tierLedgerIdentityKey, trustDomainRank, type TierLedgerIdentity } from '../classification/tier-ledger.ts';
import { resolveEmbeddingLedgerPath } from '../embedding-ledger.ts';
import { pruneSupersededStoreCopy, queueTierLedgerEntry, type TierMoveOptions } from './tier-move.ts';
import { compareContentVersions } from './tier-content-purge.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

const STATE = 'automatic-superseded-prune-v1';
const PAGE_SIZE = 200;
/** Passes one item may fail before the sweep steps past it and walks again later (#1412). */
const MAX_ITEM_FAILURES = 3;
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
  /** The item the last pass failed on, and how many passes in a row failed on it. */
  failing?: { key: string; count: number };
  /** Original chunk counts of receipts stepped past, so a later walk still audits what was already stripped. */
  parked?: Record<string, Pending['copies']>;
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
      if (state.parked) delete state.parked[tierLedgerIdentityKey(pending.identity)];
      delete state.pending;
      delete state.failing;
      save();
    });
  };
  let attempt: TierLedgerIdentity | undefined;
  try {
    if (state.pending) {
      attempt = state.pending.identity;
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
      attempt = identity;
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
        const parked = state.parked?.[tierLedgerIdentityKey(identity)];
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
          // A receipt stepped past may have stripped this copy already: keep its original count.
          const original = parked?.find(target => target.corpusId === copy.corpusId)?.chunks ?? 0;
          return { corpusId: copy.corpusId, chunks: Math.max(chunks, original) };
        });
        if (unproven) { report.kept++; return; }
        state.pending = { identity, generation: record.generation, copies: targets,
          embeddingLedger: state.embeddingLedger! };
        // Commit the receipt and rollback refusal BEFORE any store is stripped.
        ledger.writeMeta(`tier-content-purged:${tierLedgerIdentityKey(identity)}`, String(record.generation));
        save();
      });
      if (state.pending) finishPending();
      else { state.after = identity; delete state.failing; save(); }
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
  } catch (error) {
    // Cursor stays before the failed item; its original counts stay durable.
    report.failed++;
    report.complete = false;
    if (attempt) stepPastRepeatedFailure(attempt, error);
  }
  return report;

  // One item that keeps failing (a store that stays unavailable, a body that
  // cannot be verified) must not hold the rest of the ledger behind it. After
  // MAX_ITEM_FAILURES passes the cursor moves past it and the sweep walks the
  // ledger again later, so the item is retried and the sweep is never marked
  // done over it. The log names the ledger and corpora, never item content.
  function stepPastRepeatedFailure(identity: TierLedgerIdentity, error: unknown): void {
    try {
      // Start from what is durable: the failed attempt's ledger transaction
      // rolled back, so its in-memory edits (deleted totals, cursor) must not be saved.
      const durable: State = JSON.parse(ledger.readMeta(STATE) || '{}');
      const key = tierLedgerIdentityKey(identity);
      const count = durable.failing?.key === key ? durable.failing.count + 1 : 1;
      const corpora = durable.pending?.copies.map(copy => copy.corpusId).join(',') || 'unknown';
      // The error's name only: a message from below could carry a path.
      const reason = error instanceof Error ? error.name : 'unknown';
      console.warn(`[tier-auto-prune] ledger=${ledger.ledgerId()} corpora=${corpora} failures=${count} reason=${reason}`);
      if (count < MAX_ITEM_FAILURES) {
        durable.failing = { key, count };
      } else {
        // A pending receipt's tier-content-purged marker stays: some copies
        // may already be stripped, so rollback stays refused for this item.
        // Its original counts are parked for the walk that retries it.
        if (durable.pending) (durable.parked ??= {})[key] = durable.pending.copies;
        delete durable.pending;
        delete durable.failing;
        durable.after = identity;
        durable.retry = true;
      }
      ledger.writeMeta(STATE, JSON.stringify(durable));
    } catch {
      // The ledger itself is unavailable; the next pass starts from the same place.
    }
  }
}
