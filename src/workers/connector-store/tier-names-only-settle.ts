// Settle stored items the owner keeps names-only (review fix 2026-10-02,
// classifier p4 follow-up). Source-agnostic: it reads only the tier ledger
// and each store's own folder dispositions.
//
// Since classifier p4 a names-only item is decided on its names when it is
// listed (`TierClassificationInput.namesOnly`): its text never arrives, so
// nothing waits on it. Items recorded before p4 were left pending on text
// that never comes, and an incremental listing never lists an unchanged item
// again. This pass finds routed rows held only because their text was not
// read, asks the store that keeps their names whether a names-only rule
// covers them (`metadataOnlyRuleForLocator`), and records those exactly as a
// p4 listing would: the names decide both layers, `content:names_only`. The
// placement of an unread item in a lane whose text arrives later is its
// names' copy either way, so no store is written and nothing moves.
//
// Bounded: a page of rows per call, resumed from the ledger, starting over
// once the end is reached.

import type { TierDecision } from '../classification/tier-classifier.ts';
import { copyServingLayer, type TierLedgerIdentity, type TierLedgerRecord } from '../classification/tier-ledger.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

export const DEFAULT_NAMES_ONLY_SETTLE_ROWS = 500;
const SETTLE_META_KEY = 'names_only_settle_after';

export interface TierNamesOnlySettleReport {
  /** Rows held only for unread text that were checked. */
  checked: number;
  /** Of those, the ones a names-only rule covers: settled on their names. */
  settled: number;
}

export function settleNamesOnlyItems(options: { set: TieredStoreSet; limit?: number }): TierNamesOnlySettleReport {
  const report: TierNamesOnlySettleReport = { checked: 0, settled: 0 };
  const { set } = options;
  // Only a lane whose text arrives after listing routes an unread item.
  if (!set.readsContentLater()) return report;
  const ledger = set.ledger;
  const limit = Math.max(1, options.limit ?? DEFAULT_NAMES_ONLY_SETTLE_ROWS);
  const after = parseIdentity(ledger.readMeta(SETTLE_META_KEY));
  const rows = ledger.listAwaitingText({ limit, ...(after ? { after } : {}) });
  for (const record of rows) {
    report.checked += 1;
    try {
      if (settleOne(set, record)) report.settled += 1;
    } catch {
      // Left pending; the item's next listing or a later pass settles it.
    }
  }
  const last = rows.at(-1);
  ledger.writeMeta(SETTLE_META_KEY, rows.length >= limit && last ? JSON.stringify(identityOf(last)) : '');
  return report;
}

function settleOne(set: TieredStoreSet, record: TierLedgerRecord): boolean {
  if (!record.reasons.includes('content:unread') || record.decidedBy === 'override') return false;
  const identity = identityOf(record);
  const current = set.ledger.copies(identity).filter((copy) => copy.state === 'current');
  const names = copyServingLayer(current, 'metadata');
  const domain = names ? set.domainForCorpus(names.corpusId) : undefined;
  const store = domain ? set.store(domain) : undefined;
  const exported = store?.exportItemCopy(identity);
  if (!store || !exported) return false;
  const locator = exported.columns['locator_uri'];
  if (store.metadataOnlyRuleForLocator(typeof locator === 'string' ? locator : undefined) === undefined) return false;
  const decision: TierDecision = {
    metadataTier: record.metadataTier,
    contentTier: record.metadataTier,
    decidedBy: record.decidedBy as TierDecision['decidedBy'],
    reasons: [...record.reasons.filter((reason) => !reason.startsWith('content:')), 'content:names_only'],
    state: 'current',
    contentRead: false,
    metadataPending: false,
    contentPending: false,
    metadataForced: record.metadataForced,
    metadataFlagged: record.metadataFlagged,
    engineVersion: record.engineVersion,
    mapRevision: record.mapRevision,
    snifferId: 'undecided',
  };
  const recorded = set.ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision), { stagedLandingAllowed: true });
  return recorded.outcome === 'updated' || recorded.outcome === 'unchanged';
}

function parseIdentity(raw: string | undefined): TierLedgerIdentity | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<TierLedgerIdentity>;
    if (typeof parsed.provider !== 'string' || typeof parsed.accountScope !== 'string' || typeof parsed.providerItemId !== 'string') return undefined;
    return {
      provider: parsed.provider,
      accountScope: parsed.accountScope,
      providerItemId: parsed.providerItemId,
      ...(typeof parsed.providerConversationId === 'string' ? { providerConversationId: parsed.providerConversationId } : {}),
    };
  } catch {
    return undefined;
  }
}

function identityOf(record: TierLedgerRecord): TierLedgerIdentity {
  return {
    provider: record.provider,
    accountScope: record.accountScope,
    providerItemId: record.providerItemId,
    ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
  };
}
