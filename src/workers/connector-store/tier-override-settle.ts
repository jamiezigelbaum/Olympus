// Per-item owner overrides applied to items already stored (reviewer demo
// fix 2026-10-11). Source-agnostic: it reads only the tier ledger and, for a
// Secrets override, the item's stored copy.
//
// `olympus tier set <item> <tier>` saves the override in the set ledger, and
// a listing applies it (`decideItemTiers` reads it). An incremental listing
// never lists an unchanged item again, so an override on an unchanged file
// never applied: a Private item set Personal stayed Private. This pass
// applies every override whose item does not yet sit at the override's tiers,
// in both directions, through the same router write a listing makes
// (`recordRoutedPlacement`):
//
// - a raise is queued hidden first (the CLI already hid it at once, see
//   `TierLedger.queueOwnerRaise`; this covers anything it could not);
// - a lowering is queued as a move, the item visible where it is until the
//   move lands (the sniffer service's automatic moves, or the owner-approved
//   migration on an install whose embeddings are not all the built-in model);
// - Secrets hides every copy at once and hands them to the one Secrets
//   policy (secrets-disposition.ts), as an owner-marked secret.
//
// A move in flight toward tiers less private than the owner's is invalidated
// and retargeted in one write (`TierLedger.queueOwnerRaise`); any other move
// lands first and the override applies after it. Every write re-checks, in
// its own transaction, that the override and the item's generation are still
// what this pass read (`TierOwnerOverrideGuard`). Only tier overrides act here: `not-secret` needs the item's
// signals and text, which its next listing supplies.

import { classifyItemTiers, type TierDecision, type TierKey } from '../classification/tier-classifier.ts';
import {
  trustDomainRank,
  type TierLedgerIdentity,
  type TierLedgerRecord,
  type TierOwnerOverrideGuard,
} from '../classification/tier-ledger.ts';
import type { SourceTrustDomain } from '../../core/source-index/types.ts';
import { secretsDisposition } from './secrets-disposition.ts';
import { settleRoutedSecrets } from './tier-rejudge.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

export interface TierOverrideSettleReport {
  /** Routed items with an override that were read. */
  checked: number;
  /** Overrides recorded with no change of stores (already in the right store). */
  updated: number;
  /** Raises queued, every copy hidden first. */
  raised: number;
  /** Lowerings queued as moves (visible where they are until the move lands). */
  lowered: number;
  /** Items an override made Secrets: hidden and handed to the Secrets policy. */
  secrets: number;
  /** Mid-move items whose move does not carry the override yet: applied once it lands. */
  heldMoving: number;
}

export function applyOwnerOverrides(options: {
  set: TieredStoreSet;
  /** @internal Test hook: runs after the overrides are read, before any is applied (another process's write). */
  afterRead?: () => void;
}): TierOverrideSettleReport {
  const report: TierOverrideSettleReport = { checked: 0, updated: 0, raised: 0, lowered: 0, secrets: 0, heldMoving: 0 };
  const { set } = options;
  const ledger = set.ledger;
  let retirePublic = false;
  try {
    retirePublic = set.classification()?.retirePublic === true;
  } catch {
    // An override does not depend on the owner's map or rules.
  }
  const overrides = ledger.listRoutedOverrides();
  options.afterRead?.();
  for (const { record, override } of overrides) {
    if (override.kind !== 'tier') continue;
    report.checked += 1;
    try {
      // What was read here authorizes the write only while it still holds:
      // the ledger re-checks the override and the generation in the write's
      // own transaction and refuses if another process changed either.
      applyOne(set, record, override.tier, retirePublic, report, { generation: record.generation, override });
    } catch {
      // Left as it was; the next pass (or the item's next listing) applies it.
    }
  }
  return report;
}

function applyOne(
  set: TieredStoreSet,
  record: TierLedgerRecord,
  tier: TierKey,
  retirePublic: boolean,
  report: TierOverrideSettleReport,
  guard: TierOwnerOverrideGuard,
): void {
  const ledger = set.ledger;
  const identity = identityOf(record);
  // Exactly the decision a listing makes for an overridden item.
  const decision: TierDecision = classifyItemTiers(
    { signals: {}, provider: record.provider, subject: identity },
    { override: { kind: 'tier', tier }, ...(retirePublic ? { retirePublic: true } : {}) },
  );
  const secrets = decision.contentTier === 'secrets';
  if (record.state === 'moving' && !secrets) {
    if (record.targetMetadataTier === decision.metadataTier && record.targetContentTier === decision.contentTier) return;
    // A move in flight toward tiers less private than the owner's is
    // invalidated and retargeted, unsafe copies hidden (one ledger write);
    // any other move lands first and the override applies after it.
    const outcome = ledger.queueOwnerRaise(identity, decision, leastPrivateDomain(set, decision), { guard });
    if (outcome === 'none') report.heldMoving += 1;
    else report.raised += 1;
    return;
  }
  const atTiers = record.metadataTier === decision.metadataTier && record.contentTier === decision.contentTier;
  if (atTiers && record.state !== 'moving') {
    if (!secrets && record.decidedBy === 'override') return;
    if (secrets && !secretsCopiesLeft(set, identity)) return;
  }
  if (secrets) {
    const exported = storedCopy(set, identity);
    if (exported) {
      if (settleRoutedSecrets(set, identity, decision, exported, { findingKinds: ['owner_marked_secret'] }, { guard })) report.secrets += 1;
      return;
    }
    // No stored copy to read the location from: hidden all the same.
    if (ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision), { guard }).outcome === 'secrets') report.secrets += 1;
    return;
  }
  const recorded = ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision), { guard });
  switch (recorded.outcome) {
    case 'queued_move':
      if (recorded.raise) report.raised += 1;
      else report.lowered += 1;
      return;
    case 'held_moving':
      report.heldMoving += 1;
      return;
    case 'updated':
    case 'inserted':
      report.updated += 1;
      return;
    default:
      return;
  }
}

/** The least private store the decision's placement uses: a current copy below it is unsafe. */
function leastPrivateDomain(set: TieredStoreSet, decision: TierDecision): SourceTrustDomain {
  const copies = set.placementFor(decision).copies;
  return copies.reduce<SourceTrustDomain>(
    (lowest, copy) => (trustDomainRank(copy.trustDomain) < trustDomainRank(lowest) ? copy.trustDomain : lowest),
    'secure_local',
  );
}

/** Whether a Secrets item still has copies the Secrets policy has not settled. */
function secretsCopiesLeft(set: TieredStoreSet, identity: TierLedgerIdentity): boolean {
  const copies = set.ledger.copies(identity);
  return secretsDisposition() === 'tombstone_now'
    ? copies.length > 0
    : copies.some((copy) => copy.state === 'current');
}

/** The item's stored copy (names first), current or hidden, for a Secrets location. */
function storedCopy(set: TieredStoreSet, identity: TierLedgerIdentity) {
  const copies = set.ledger.copies(identity)
    .sort((left, right) => Number(right.state === 'current') - Number(left.state === 'current'));
  for (const copy of copies) {
    const domain = set.domainForCorpus(copy.corpusId);
    const exported = domain ? set.store(domain)?.exportItemCopy(identity) : undefined;
    if (exported) return exported;
  }
  return undefined;
}

function identityOf(record: TierLedgerRecord): TierLedgerIdentity {
  return {
    provider: record.provider,
    accountScope: record.accountScope,
    providerItemId: record.providerItemId,
    ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
  };
}
