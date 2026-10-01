// Re-judge routed items after the classifier or the sniffer's prompt changes
// (owner ruling 2026-10-01). Source-agnostic: it reads only the tier ledger
// and the stored copy of an item's text, never a source.
//
// A routed item's content decision is recorded once, when its text lands.
// Nothing re-made it when the classifier (TIER_CLASSIFIER_VERSION) or the
// sniffer's prompt changed, so an item judged Personal under older rules
// stayed Personal. This pass finds those items (`listRejudgeCandidates`),
// reads the stored text back from the store that serves it, and runs the
// shared content pass again with the item's names, exactly as a landing does.
//
// - Owner overrides, force rules and owner rules on the names are never
//   re-judged; neither are Secrets, pending or mid-move items.
// - Personal to Private is immediate: a decision that needs the item held
//   (an open sniffer question) or Private queues a RAISE, and a raise hides
//   every current copy at once (hide first) until the move lands it held.
// - Private to Personal only ever follows the sniffer's verdict: the
//   re-judged item waits, held, for its question like any landing.
// - Bounded per call and paged by identity, so a large ledger is worked
//   through a page per sniffer tick without starving anything.
// - Runs only with a sniffer configured (the sniffer service calls it): with
//   no private lane, recorded decisions stand exactly as before.

import {
  classifyContentTier,
  maxTier,
  namesDecidedByOwner,
  TIER_CLASSIFIER_VERSION,
  type TierDecision,
} from '../classification/tier-classifier.ts';
import { copyServingLayer, type TierLedgerIdentity, type TierLedgerRecord } from '../classification/tier-ledger.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

/** Items re-judged per call (one call per sniffer tick, per set). */
export const DEFAULT_TIER_REJUDGE_PER_PASS = 100;

export interface TierRejudgeReport {
  /** Candidates read from the ledger. */
  seen: number;
  /** Decisions recorded with no change of stores. */
  updated: number;
  /** Re-judged decisions that need other stores: queued moves (a raise hides first). */
  movesQueued: number;
  /** Re-judged and waiting on a sniffer question (held Private). */
  held: number;
  /** Nothing to re-read (no stored text) or a Secrets finding left to the landing path. */
  skipped: number;
  failed: number;
}

export interface TierRejudgeOptions {
  set: TieredStoreSet;
  limit?: number;
  /** Where the previous call stopped; the returned `next` continues from it. */
  after?: TierLedgerIdentity;
}

export function rejudgeRoutedItems(options: TierRejudgeOptions): { report: TierRejudgeReport; next?: TierLedgerIdentity } {
  const report: TierRejudgeReport = { seen: 0, updated: 0, movesQueued: 0, held: 0, skipped: 0, failed: 0 };
  const { set } = options;
  const classification = set.classification();
  // No sniffer, or inputs that cannot be trusted: recorded decisions stand.
  if (!classification?.sniffer || classification.unavailableReason) return { report };
  const ledger = set.ledger;
  const limit = Math.max(1, options.limit ?? DEFAULT_TIER_REJUDGE_PER_PASS);
  const candidates = ledger.listRejudgeCandidates({
    engineVersion: TIER_CLASSIFIER_VERSION,
    snifferId: classification.sniffer.id,
    ...(options.after ? { after: options.after } : {}),
    limit,
  });
  for (const record of candidates) {
    report.seen += 1;
    try {
      rejudgeOne(set, record, classification, report);
    } catch {
      // The item keeps its recorded decision; a later pass tries again.
      report.failed += 1;
    }
  }
  const last = candidates.at(-1);
  // A short page means the ledger was read to its end: start over next time.
  const next = last && candidates.length >= limit ? identityOf(last) : undefined;
  return { report, ...(next ? { next } : {}) };
}

function rejudgeOne(
  set: TieredStoreSet,
  record: TierLedgerRecord,
  classification: NonNullable<ReturnType<TieredStoreSet['classification']>>,
  report: TierRejudgeReport,
): void {
  const ledger = set.ledger;
  const identity = identityOf(record);
  if (ledger.getOverride(identity)) {
    report.skipped += 1;
    return;
  }
  const current = ledger.copies(identity).filter((copy) => copy.state === 'current');
  const serving = copyServingLayer(current, 'content');
  const domain = serving ? set.domainForCorpus(serving.corpusId) : undefined;
  const exported = domain ? set.store(domain)?.exportItemCopy(identity) : undefined;
  const text = exported?.chunks.map((chunk) => chunk.boundedText).join('\n') ?? '';
  if (!exported || !text.trim()) {
    report.skipped += 1;
    return;
  }
  const title = columnString(exported.columns['title']);
  const path = columnString(exported.columns['locator_uri']);
  const sender = columnString(exported.columns['sender_label']);
  const content = classifyContentTier(
    {
      text,
      metadataTier: record.metadataTier,
      metadataForced: record.metadataForced,
      metadataFlagged: record.metadataFlagged,
      metadataOwnerDecided: namesDecidedByOwner(record.reasons),
      ...(title ? { title } : {}),
      ...(path ? { path } : {}),
      ...(sender ? { sender } : {}),
      subject: identity,
    },
    {
      ...(classification.sensitivityMap ? { sensitivityMap: classification.sensitivityMap } : {}),
      sniffer: classification.sniffer!,
      ...(classification.retirePublic ? { retirePublic: true } : {}),
    },
  );
  if (content.contentTier === 'secrets') {
    // A secret in stored text is the landing path's to settle (it records the
    // location and hides every copy); a re-judge never half-does that.
    report.skipped += 1;
    return;
  }
  const decision: TierDecision = {
    metadataTier: record.metadataTier,
    contentTier: maxTier(content.contentTier, record.metadataTier),
    decidedBy: content.decidedBy,
    reasons: [
      ...record.reasons.filter((reason) => !reason.startsWith('content:')),
      ...content.reasons,
    ],
    state: record.metadataPending || content.contentPending ? 'pending' : 'current',
    contentRead: true,
    metadataPending: record.metadataPending,
    contentPending: content.contentPending,
    metadataForced: record.metadataForced,
    metadataFlagged: record.metadataFlagged,
    engineVersion: content.engineVersion,
    mapRevision: content.mapRevision,
    snifferId: content.snifferId,
  };
  const recorded = ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision));
  if (recorded.outcome === 'queued_move') report.movesQueued += 1;
  else report.updated += 1;
  if (content.contentPending) report.held += 1;
}

function identityOf(record: TierLedgerRecord): TierLedgerIdentity {
  return {
    provider: record.provider,
    accountScope: record.accountScope,
    providerItemId: record.providerItemId,
    ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
  };
}

function columnString(value: string | number | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
