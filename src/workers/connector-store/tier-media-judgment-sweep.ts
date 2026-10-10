// The photo judge's verdicts, applied to the tier ledger (docs/design/
// photo-embeddings.md, owner decision 2026-10-08). Source-agnostic: it reads
// only the stores' judgments of pictures and the tier ledger.
//
// A photo's content lands Private while its picture is unjudged. The judge
// runs where the photo is first embedded (its Private store), and records a
// verdict per picture. This pass then re-decides each item carrying a newly
// judged picture, exactly as a re-judge does (`rejudgeStoredContent`):
//
// - sensitive: the content stays Private, its reason now names the category;
// - ordinary: the content is judged like any other file's (its text through
//   the usual rules, Personal by default), so a move out of the Private
//   store is queued and carried out by the usual tier-move machinery (the
//   sniffer's automatic moves, or the owner-approved migration);
// - unjudged: Private. Recorded unapplied only when it replaces an ordinary
//   verdict (a new judge could not read the picture), so an item that verdict
//   let out of Private is raised back.
//
// Owner overrides, Secrets and legacy (never routed) items are left as they
// are. An item mid-move, or waiting on its names, is tried again later, its
// judgment sent to the back of the queue so it cannot starve the rest. A
// bounded page per call; each judgment is applied once.

import type { TierLedgerIdentity } from '../classification/tier-ledger.ts';
import { emptyTierRejudgeReport, rejudgeStoredContent, type TierRejudgeReport } from './tier-rejudge.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

export const DEFAULT_MEDIA_JUDGMENT_SWEEP_LIMIT = 200;

export interface MediaJudgmentSweepReport extends TierRejudgeReport {
  /** Judgments applied (marked done) this call. */
  applied: number;
  /** Judgments left for a later call (an item mid-move or waiting on its names). */
  waiting: number;
}

export function applyMediaJudgments(options: {
  set: TieredStoreSet;
  limit?: number;
  /** Whether queued moves run automatically here (see TierRejudgeOptions.autoMoves). */
  autoMoves?: boolean;
}): MediaJudgmentSweepReport {
  const report: MediaJudgmentSweepReport = { ...emptyTierRejudgeReport(), applied: 0, waiting: 0 };
  const { set } = options;
  const ledger = set.ledger;
  const classification = set.classification();
  const limit = Math.max(1, options.limit ?? DEFAULT_MEDIA_JUDGMENT_SWEEP_LIMIT);
  for (const store of set.openStores()) {
    const page = store.unappliedMediaJudgments(limit);
    const done: typeof page = [];
    const waiting: string[] = [];
    for (const entry of page) {
      let ready = true;
      for (const identity of entry.items) {
        report.seen += 1;
        const record = ledger.getCurrent(identity as TierLedgerIdentity);
        // Legacy (never routed), or gone: nothing in the ledger to re-decide.
        if (!record || !record.routed) continue;
        if (record.state === 'moving' || record.metadataPending) {
          ready = false;
          continue;
        }
        if (record.contentTier === 'secrets' || record.metadataTier === 'secrets') continue;
        // An unusable map or rules file: decisions wait rather than be made without them.
        if (classification?.unavailableReason) {
          ready = false;
          continue;
        }
        try {
          rejudgeStoredContent(set, record, {
            ...(classification?.sniffer ? { sniffer: classification.sniffer } : {}),
            ...(classification?.retirePublic ? { retirePublic: true } : {}),
            report,
            autoMoves: options.autoMoves === true,
            // A raise (a verdict that no longer lets the content out of
            // Private) hides the copies outside Private at once.
            hideRaises: true,
          });
        } catch {
          report.failed += 1;
          ready = false;
        }
      }
      if (ready) done.push(entry);
      else waiting.push(entry.mediaSha256);
    }
    store.markMediaJudgmentsApplied(done);
    store.markMediaJudgmentsWaiting(waiting);
    report.waiting += waiting.length;
    report.applied += done.length;
  }
  return report;
}
