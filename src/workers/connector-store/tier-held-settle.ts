// Hold the text of items recorded Personal-first (#1316). Source-agnostic: it
// reads only the tier ledger and re-places rows through the set's own
// placement.
//
// Before #1316 an open model question did not hold an item's text: the
// decision was recorded `content:personal_first` and its text was stored,
// searchable and embedded, in a Personal store while the question waited.
// Every open question holds its text now (`contentHeldForJudgment`), but an
// install upgraded across that change keeps the old placements until each
// item is placed again, and an unchanged item may never be listed again.
// This pass re-records each such row as it stands, without the legacy
// reason, at the placement the hold gives it: when that is more private than
// where its copies sit, the ledger hides them at once and queues the move
// (`recordRoutedPlacement`), so the text leaves Personal search and
// embedding before the move runs. Nothing is decided and no store is written.
//
// Bounded: a page of rows per call from a bounded window of the ledger,
// resumed from the ledger. A lap without any legacy rows retires the pass.

import { PERSONAL_FIRST_REASON, type TierDecision } from '../classification/tier-classifier.ts';
import {
  PERSONAL_FIRST_SETTLE_CURSOR, PERSONAL_FIRST_SETTLE_DONE,
  parseTierLedgerIdentity, tierLedgerIdentityOfRecord, type TierLedgerRecord,
} from '../classification/tier-ledger.ts';
import { findInLedger, runPassHere, runPassOffThread, turn, type LoopPass } from './loop-pass.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

export const DEFAULT_HELD_SETTLE_ROWS = 500;

export interface TierHeldSettleReport {
  /** Legacy Personal-first rows found. */
  checked: number;
  /** Of those, the ones re-placed held. */
  settled: number;
  /** Of those, the ones whose copies were hidden and a move queued. */
  movesQueued: number;
  failed: number;
  retired: boolean;
}

/** The settle on its caller's connection (a direct caller, not the engine's loop). */
export function settlePersonalFirstItems(options: { set: TieredStoreSet; limit?: number }): Pick<TierHeldSettleReport, 'checked' | 'settled' | 'movesQueued'> {
  const { checked, settled, movesQueued } = runPassHere(personalFirstSettlePass(options));
  return { checked, settled, movesQueued };
}

/** The settle on the engine's loop: its window is read on the ledger's read worker, a turn between rows. */
export function settlePersonalFirstItemsOffThread(options: { set: TieredStoreSet; limit?: number; turn?: () => Promise<void> | undefined }): Promise<TierHeldSettleReport> {
  return runPassOffThread(personalFirstSettlePass(options), { family: 'personal-first-settle', ...(options.turn ? { turn: options.turn } : {}) });
}

function* personalFirstSettlePass(options: { set: TieredStoreSet; limit?: number }): LoopPass<TierHeldSettleReport> {
  const report: TierHeldSettleReport = { checked: 0, settled: 0, movesQueued: 0, failed: 0, retired: false };
  const { set } = options;
  const ledger = set.ledger;
  if (ledger.readMeta(PERSONAL_FIRST_SETTLE_DONE) === '1') return { ...report, retired: true };
  const limit = Math.max(1, options.limit ?? DEFAULT_HELD_SETTLE_ROWS);
  const saved = ledger.readMeta(PERSONAL_FIRST_SETTLE_CURSOR) ?? '';
  // A checkpoint written before retirement was tracked cannot prove the prefix was clean.
  const tracked = saved.startsWith('0:') || saved.startsWith('1:');
  const after = tracked ? parseTierLedgerIdentity(saved.slice(2)) : undefined;
  const { records, resumeAfter } = yield* findInLedger(ledger, () => ledger.listPersonalFirstWindowSteps({ limit, ...(after ? { after } : {}) }));
  for (const found of records) {
    yield* turn();
    report.checked += 1;
    // Found on an older snapshot: settled from the row as it is now, read by
    // key, and only while it still waits Personal-first (a verdict that
    // landed meanwhile keeps the same generation and must not be undone).
    const record = set.ledger.getCurrent(tierLedgerIdentityOfRecord(found));
    if (!record?.routed || !record.contentPending || record.state === 'moving' || !record.reasons.includes(PERSONAL_FIRST_REASON)) continue;
    try {
      const outcome = settleOne(set, record);
      if (outcome === 'queued_move') report.movesQueued += 1;
      if (outcome === 'queued_move' || outcome === 'updated' || outcome === 'unchanged') report.settled += 1;
    } catch {
      // Left as it is; a later pass or the item's next listing places it.
      report.failed += 1;
    }
  }
  const matched = (after !== undefined && saved.startsWith('1:')) || report.checked > 0;
  ledger.writeSettleProgress(PERSONAL_FIRST_SETTLE_CURSOR, resumeAfter ? `${Number(matched)}:${JSON.stringify(resumeAfter)}` : '');
  if (!resumeAfter && !matched) {
    ledger.writeSettleProgress(PERSONAL_FIRST_SETTLE_DONE, '1');
    report.retired = true;
  }
  return report;
}

function settleOne(set: TieredStoreSet, record: TierLedgerRecord): string {
  const identity = tierLedgerIdentityOfRecord(record);
  const decision: TierDecision = {
    metadataTier: record.metadataTier,
    contentTier: record.contentTier,
    decidedBy: record.decidedBy as TierDecision['decidedBy'],
    reasons: record.reasons.filter((reason) => reason !== PERSONAL_FIRST_REASON),
    state: 'pending',
    contentRead: record.contentRead,
    metadataPending: record.metadataPending,
    contentPending: true,
    metadataForced: record.metadataForced,
    metadataFlagged: record.metadataFlagged,
    engineVersion: record.engineVersion,
    mapRevision: record.mapRevision,
    snifferId: 'undecided',
  };
  return set.ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision), {
    stagedLandingAllowed: true,
    guard: { generation: record.generation, override: set.ledger.getOverride(identity) },
  }).outcome;
}
