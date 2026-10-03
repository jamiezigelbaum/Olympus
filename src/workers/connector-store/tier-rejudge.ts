// Re-judge routed items after the classifier or the sniffer's prompt changes
// (owner ruling 2026-10-01). Source-agnostic: it reads only the tier ledger
// and the stored copy of an item's text, never a source.
//
// A routed item's content decision is recorded once, when its text lands.
// Nothing re-made it when the classifier (TIER_CLASSIFIER_VERSION) or the
// sniffer's prompt changed, so an item judged Personal under older rules
// stayed Personal. This pass finds those items (`rejudgeCandidatePage`),
// reads the stored text back from the store that serves it, and runs the
// shared content pass again with the item's names, exactly as a landing does.
//
// - Owner overrides, force rules and owner rules on the names are never
//   re-judged; neither are Secrets, pending or mid-move items.
// - The item was visible under its previous decision, so a re-judge NEVER
//   hides it pending an answer (review fix 2026-10-02: re-judging hid items
//   far faster than answers and moves could bring them back). A decision
//   that needs the sniffer opens a re-judge question
//   (`TierLedger.openRejudgeQuestion`): the item stays exactly where it is,
//   and the sniffer's answer settles it (`applySnifferVerdict`). Only a
//   Private verdict raises it (hidden first); a Personal verdict changes
//   nothing but its reasons; a Private item judged Personal moves down.
// - A decision made at once (a cached verdict, a structured detector) is
//   recorded at once; a raise hides first.
// - On an install whose moves wait for the owner-approved migration
//   (`autoMoves` false: an embedding other than the built-in local model),
//   nothing is hidden at all: a raise is queued with the item still visible,
//   which is exactly the migration's proposal for it.
// - A secret found in stored text is settled at once like any Secrets
//   decision: every copy hidden in the same ledger write, the location
//   recorded, and the copies handed to the one Secrets policy
//   (secrets-disposition.ts).
// - A row the pass leaves as it was is stamped (`markRejudged`), so it is not
//   re-read on every tick; a page reads a bounded window of the ledger.
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
import type { ConnectorStoreItemCopy } from './local-index.ts';
import { settleSecretsCopies } from './secrets-disposition.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

/** Items re-judged per call (one call per sniffer tick, per set). */
export const DEFAULT_TIER_REJUDGE_PER_PASS = 100;
export const TIER_REJUDGE_CONNECTOR_ID = 'olympus_tier_rejudge';

export interface TierRejudgeReport {
  /** Candidates read from the ledger. */
  seen: number;
  /** Decisions recorded with no change of stores. */
  updated: number;
  /** Re-judged decisions that need other stores: queued moves (a raise hides first unless `autoMoves` is off). */
  movesQueued: number;
  /** Re-judged and waiting on a sniffer question, still where it was (never hidden for it). */
  asked: number;
  /** A secret found in stored text: hidden at once and handed to the Secrets policy. */
  secrets: number;
  /** Nothing to re-read (no stored text) or an owner override: left as it was. */
  skipped: number;
  failed: number;
}

export interface TierRejudgeOptions {
  set: TieredStoreSet;
  limit?: number;
  /** Where the previous call stopped; the returned `next` continues from it. */
  after?: TierLedgerIdentity;
  /**
   * Whether this set's queued moves run automatically (the sniffer service's
   * automatic moves: every embedding is the built-in local model). False: a
   * re-judge never hides anything; a raise is queued with the item visible,
   * for the owner-approved migration.
   */
  autoMoves?: boolean;
}

export function emptyTierRejudgeReport(): TierRejudgeReport {
  return { seen: 0, updated: 0, movesQueued: 0, asked: 0, secrets: 0, skipped: 0, failed: 0 };
}

export function rejudgeRoutedItems(options: TierRejudgeOptions): { report: TierRejudgeReport; next?: TierLedgerIdentity } {
  const report = emptyTierRejudgeReport();
  const { set } = options;
  const classification = set.classification();
  // No sniffer, or inputs that cannot be trusted: recorded decisions stand.
  if (!classification?.sniffer || classification.unavailableReason) return { report };
  const ledger = set.ledger;
  const limit = Math.max(1, options.limit ?? DEFAULT_TIER_REJUDGE_PER_PASS);
  const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: classification.sniffer.id };
  const page = ledger.rejudgeCandidatePage({
    ...key,
    ...(options.after ? { after: options.after } : {}),
    limit,
  });
  for (const record of page.records) {
    report.seen += 1;
    try {
      rejudgeOne(set, record, classification, report, key, options.autoMoves === true);
    } catch {
      // The item keeps its recorded decision; a later pass tries again.
      report.failed += 1;
    }
  }
  return { report, ...(page.next ? { next: page.next } : {}) };
}

function rejudgeOne(
  set: TieredStoreSet,
  record: TierLedgerRecord,
  classification: NonNullable<ReturnType<TieredStoreSet['classification']>>,
  report: TierRejudgeReport,
  key: { engineVersion: string; snifferId: string },
  autoMoves: boolean,
): void {
  const ledger = set.ledger;
  const identity = identityOf(record);
  if (ledger.getOverride(identity)) {
    ledger.markRejudged(identity, key);
    report.skipped += 1;
    return;
  }
  const current = ledger.copies(identity).filter((copy) => copy.state === 'current');
  const serving = copyServingLayer(current, 'content');
  const domain = serving ? set.domainForCorpus(serving.corpusId) : undefined;
  const exported = domain ? set.store(domain)?.exportItemCopy(identity) : undefined;
  const text = exported?.chunks.map((chunk) => chunk.boundedText).join('\n') ?? '';
  if (!exported || !text.trim()) {
    // Nothing to read back: the decision stands, and the row is not re-read
    // until the classifier or the sniffer changes again.
    ledger.markRejudged(identity, key);
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
      sniffer: classification.sniffer!,
      ...(classification.retirePublic ? { retirePublic: true } : {}),
    },
  );
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
  if (content.contentTier === 'secrets') {
    settleRoutedSecrets(set, identity, decision, exported, {
      text,
      findingKinds: content.reasons
        .filter((reason) => reason.startsWith('content:secret:'))
        .map((reason) => reason.slice('content:secret:'.length)),
    });
    report.secrets += 1;
    return;
  }
  if (content.contentPending) {
    // Asked, not hidden: the item stays where it is until the answer.
    if (ledger.openRejudgeQuestion(identity, {
      expectedGeneration: record.generation,
      decision,
      keepVisible: !autoMoves,
    })) report.asked += 1;
    else report.skipped += 1;
    return;
  }
  const recorded = ledger.recordRoutedPlacement(
    identity,
    decision,
    set.placementFor(decision),
    autoMoves ? {} : { queueWithoutHiding: true },
  );
  ledger.markRejudged(identity, key);
  if (recorded.outcome === 'queued_move') report.movesQueued += 1;
  else report.updated += 1;
}

/**
 * A routed item judged Secrets after it was stored (a re-judge found a
 * secret in its text; an owner rule made it Secrets): one ledger write hides
 * every copy (Secrets outrank everything), the location is recorded, and the
 * copies go to the one Secrets policy (secrets-disposition.ts), exactly as a
 * landing settles one. Returns whether the item became Secrets.
 */
export function settleRoutedSecrets(
  set: TieredStoreSet,
  identity: TierLedgerIdentity,
  decision: TierDecision,
  exported: ConnectorStoreItemCopy,
  finding: { text?: string; findingKinds: readonly string[] },
): boolean {
  const ledger = set.ledger;
  const recorded = ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision));
  if (recorded.outcome !== 'secrets') return false;
  const locator = columnString(exported.columns['locator_uri']);
  const title = columnString(exported.columns['title']);
  const namesReleasable = decision.metadataTier === 'public' || decision.metadataTier === 'private';
  const folderKeys = storedFolderKeys(exported.columns['source_scope_folder_keys_json']);
  const scopeGeneration = columnString(exported.columns['source_scope_generation']);
  const scopeRevision = columnString(exported.columns['source_scope_revision']);
  set.secrets()?.record({
    identity: exported.identity,
    ...(locator ? { locator } : {}),
    ...(title && namesReleasable ? { title } : {}),
    namesReleasable,
    ...(folderKeys.length > 0 ? { folderKeys } : {}),
    ...(scopeGeneration && scopeRevision ? { scopeGeneration, scopeRevision } : {}),
    findingKinds: finding.findingKinds.length > 0 ? finding.findingKinds : ['owner_marked_secret'],
    ...(finding.text !== undefined ? { text: finding.text } : {}),
  });
  settleSecretsCopies({
    ledger,
    identity: exported.identity,
    copies: recorded.previousCopies,
    storeFor: (corpusId) => {
      const domain = set.domainForCorpus(corpusId);
      return domain ? set.store(domain) : undefined;
    },
    connectorId: TIER_REJUDGE_CONNECTOR_ID,
  });
  return true;
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

function storedFolderKeys(value: string | number | null | undefined): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}
