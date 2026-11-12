// One-time upgrade cleanup for automatic moves made before source pruning.
// Migration rollback copies and Secrets retirement keep their own policies.
import { copyServingLayer, tierLedgerIdentityKey, trustDomainRank, type TierLedgerIdentity } from '../classification/tier-ledger.ts';
import { resolveEmbeddingLedgerPath } from '../embedding-ledger.ts';
import { pruneSupersededStoreCopy, queueTierLedgerEntry, type TierMoveOptions } from './tier-move.ts';
import { compareContentVersions } from './tier-content-purge.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';
import { registeredTierSets } from './tier-set-registry.ts';
import { withIdleStoreReclaim } from '../../core/store-reclaim-admission.ts';
import { SUPERSEDED_SWEEP_SLICE_MS, TIER_DOMAIN_ORDER } from './tiered-store-set.ts';

const STATE = 'automatic-superseded-prune-v1';
/** How often the engine's background takes a slice of each unfinished sweep: a 250 ms slice every 5 s. */
export const SUPERSEDED_SWEEP_TICK_MS = 5_000;
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
  /** Persisted before reclaim; completion survives process death and ledger reopen. */
  reclaimed?: Record<string, { bytesBefore: number; bytesAfter?: number; done?: boolean }>;
  /** The item the last pass failed on, and how many passes in a row failed on it. */
  failing?: { key: string; count: number };
  /** Original chunk counts of receipts stepped past, so a later walk still audits what was already stripped. */
  parked?: Record<string, Pending['copies']>;
  embeddingLedger?: NonNullable<TierMoveOptions['embeddingLedger']>;
}

/** Leave smaller freelists for normal page reuse: both thresholds must be exceeded. */
const RECLAIM_MAX_RETAINED_FREE_BYTES = 64 * 1024 * 1024;
const RECLAIM_MAX_RETAINED_FREE_RATIO = 0.1;

/**
 * One store per background tick, AFTER pruning is durably done. Old completed
 * v1 ledgers also enter here: their deleted totals identify exactly which
 * stores were pruned. Request/startup maintenance never calls this function.
 */
export async function reclaimAutomaticSupersededCopies(set: TieredStoreSet): Promise<boolean> {
  return await withIdleStoreReclaim(async () => {
    const ledger = set.ledger;
    const state: State = JSON.parse(ledger.readMeta(STATE) || '{}');
    if (!state.done) return false;
    const save = () => ledger.writeMeta(STATE, JSON.stringify(state));
    for (const corpusId of Object.keys(state.deleted ?? {})) {
      if (state.reclaimed?.[corpusId]?.done) continue;
      const domain = TIER_DOMAIN_ORDER.find(domain => set.legSpec(domain)?.corpusId === corpusId);
      const store = domain && set.store(domain);
      if (!store) return false; // unavailable is retryable, never silently complete
      const space = store.reclaimablePages();
      if (!space) return false;
      let receipt = state.reclaimed?.[corpusId];
      if (!receipt) {
        receipt = (state.reclaimed ??= {})[corpusId] = { bytesBefore: space.bytes };
        if (space.free * space.pageBytes < RECLAIM_MAX_RETAINED_FREE_BYTES
          || space.free / Math.max(1, space.pages) < RECLAIM_MAX_RETAINED_FREE_RATIO) {
          receipt.done = true;
          receipt.bytesAfter = space.bytes;
        }
        save(); // durable intent before any file changes; retries ignore the thresholds
      }
      if (!receipt.done) {
        const result = await store.reclaimFreePages(SUPERSEDED_SWEEP_SLICE_MS);
        if (!result?.done) return false;
        receipt.done = true;
        receipt.bytesAfter = result.bytes;
        save(); // mark before logging, so ticks/restarts never duplicate the line
      }
      console.info(`[tier-auto-prune-reclaim] ledger=${ledger.ledgerId()} tier=${domain}`
        + ` bytes_before=${receipt.bytesBefore} bytes_after=${receipt.bytesAfter}`);
      // Only one store's disk work per tick. Completion is read next time.
      return Object.keys(state.deleted ?? {}).every(id => state.reclaimed?.[id]?.done);
    }
    return true;
  }) ?? false;
}

type SweepReport = { checked: number; purged: number; kept: number; failed: number; complete: boolean };
/** Where one call's time went, for its log line. */
type SliceTiming = { pruneMs: number; maxItemMs: number; cut: boolean };

/**
 * Bounded pages at worker startup and on maintenance ticks; a failed item
 * resumes first. With budgetMs, pages repeat until the budget is spent, the
 * walk ends or an item fails, so a large ledger finishes in hours, not days.
 */
export function sweepAutomaticSupersededCopies(set: TieredStoreSet, options: {
  limit?: number;
  budgetMs?: number;
  now?: () => number;
  embeddingLedger?: TierMoveOptions['embeddingLedger'];
} = {}): SweepReport {
  const now = options.now ?? Date.now;
  const started = now();
  const budget = options.budgetMs ?? 0;
  // A budget is checked between items, not only between pages: one page of
  // large items must not hold the thread for seconds.
  const spent = budget > 0 ? () => now() - started >= budget : () => false;
  const timing: SliceTiming = { pruneMs: 0, maxItemMs: 0, cut: false };
  const total = sweepPage(set, options, spent, now, timing);
  const limit = Math.max(1, Math.min(options.limit ?? PAGE_SIZE, PAGE_SIZE));
  let last = total.checked;
  while (budget > 0 && !total.complete && total.failed === 0 && !timing.cut
    && last === limit && !spent()) {
    const page = sweepPage(set, options, spent, now, timing);
    total.checked += page.checked; total.purged += page.purged;
    total.kept += page.kept; total.failed += page.failed;
    total.complete = page.complete;
    last = page.checked;
  }
  if (total.purged > 0 || total.failed > 0) {
    console.info(`[tier-auto-prune] ledger=${set.ledger.ledgerId()} slice_ms=${now() - started} prune_ms=${timing.pruneMs}`
      + ` max_item_ms=${timing.maxItemMs} checked=${total.checked} purged=${total.purged} complete=${total.complete}`);
  }
  return total;
}

function sweepPage(set: TieredStoreSet, options: {
  limit?: number;
  embeddingLedger?: TierMoveOptions['embeddingLedger'];
}, spent: () => boolean, now: () => number, timing: SliceTiming): SweepReport {
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
    const itemStarted = now();
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
        const pruneStarted = now();
        pruneSupersededStoreCopy(store, pending.identity);
        timing.pruneMs += now() - pruneStarted;
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
    timing.maxItemMs = Math.max(timing.maxItemMs, now() - itemStarted);
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
    const rows = ledger.listSupersededItemWindow({ ...(state.after ? { after: state.after } : {}), limit: limit - report.checked });
    for (const record of rows.slice(0, limit - report.checked)) {
      // At least one item per call, then stop as soon as the budget is spent.
      if (report.checked > 0 && spent()) { timing.cut = true; break; }
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
    if (report.checked < limit && !timing.cut) {
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

/**
 * Drives every registered set's sweep on its own clock, so a large ledger is
 * walked in hours whether or not the sniffer or a sync is running. Completed
 * pruning proceeds to reclaim; only fully reclaimed sets are skipped. The
 * timer never keeps the process alive.
 */
export function startSupersededSweepTicker(options: {
  active?: () => boolean;
  intervalMs?: number;
  sets?: () => readonly TieredStoreSet[];
  /** Tests drive the tick themselves; returns a cancel function. */
  every?: (tick: () => void, ms: number) => () => void;
} = {}): () => void {
  const finished = new WeakSet<TieredStoreSet>();
  const reclaiming = new WeakSet<TieredStoreSet>();
  const sets = options.sets ?? registeredTierSets;
  const every = options.every ?? ((tick, ms) => {
    const timer = setInterval(tick, ms);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  });
  return every(() => {
    if (options.active && !options.active()) return;
    for (const set of sets()) {
      if (finished.has(set) || reclaiming.has(set)) continue;
      if (!set.sweepSupersededSlice()) continue;
      reclaiming.add(set);
      void reclaimAutomaticSupersededCopies(set).then(done => {
        if (done) finished.add(set);
      }).catch(() => {
        // A closed/busy store or interrupted worker retains its durable intent.
      }).finally(() => { reclaiming.delete(set); });
    }
  }, options.intervalMs ?? SUPERSEDED_SWEEP_TICK_MS);
}
