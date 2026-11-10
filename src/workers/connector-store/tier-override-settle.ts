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

import {
  classifyItemTiers,
  contentDigestReason,
  heldUntilJudged,
  maxTier,
  ownerRuleMatches,
  tierRank,
  type TierDecision,
  type TierKey,
} from '../classification/tier-classifier.ts';
import {
  copyServingLayer,
  trustDomainRank,
  type TierLedgerIdentity,
  type TierLedgerRecord,
  type TierOwnerOverrideGuard,
} from '../classification/tier-ledger.ts';
import type { SourceTrustDomain } from '../../core/source-index/types.ts';
import { forgetSecretInSideStores, retireSecretRedactions, retrySecretSideStoreDebts, secretsDisposition } from './secrets-disposition.ts';
import { storedCopyOf, storedSignals } from './stored-names.ts';
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
  /** Items whose override the owner cleared ("undo"), put back to the decision it took over from. */
  restored: number;
}

export function applyOwnerOverrides(options: {
  set: TieredStoreSet;
  /** @internal Test hook: runs after the overrides are read, before any is applied (another process's write). */
  afterRead?: () => void;
}): TierOverrideSettleReport {
  const report: TierOverrideSettleReport = { checked: 0, updated: 0, raised: 0, lowered: 0, secrets: 0, heldMoving: 0, restored: 0 };
  const { set } = options;
  const ledger = set.ledger;
  let retirePublic = false;
  try {
    retirePublic = set.classification()?.retirePublic === true;
  } catch {
    // An override does not depend on the owner's map or rules.
  }
  // Secrets whose side stores could not be cleared before: every tick tries
  // again, listed or not.
  retrySecretSideStoreDebts(ledger);
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
  // Overrides the owner cleared ("undo", tier-owner-items.ts): the item goes
  // back to the decision the override took it over from, through the same
  // router write a listing makes.
  for (const record of ledger.listClearedOverrideRows()) {
    try {
      if (restoreClearedOverride(set, record)) report.restored += 1;
    } catch {
      // Left as it was; the next pass tries again.
    }
  }
  // Items that left Secrets since the last tick (here, in a listing, a move
  // landing or another process): their job names come back.
  retireSecretRedactions(ledger);
  return report;
}

/**
 * Put an item whose override was cleared back to the decision recorded before
 * the owner changed it (`TierLedger.settledDecisionBeforeOverride`), raised to
 * what the owner's current rules ask for. A rule added while the override
 * stood skipped the item (tier-rules-sweep.ts leaves overridden items alone
 * and still counts itself done), so it is applied here, in the same write;
 * rules only raise. A label rule cannot be checked from what a store keeps:
 * wherever a raising label rule could apply to the item, it keeps the
 * protection it has now, up to that rule's tier. A raise hides first and a
 * lowering stays where it is until its move lands, as for any decision a
 * listing records. The write re-checks, in its own transaction, that no
 * override was set again and the generation is still the one read. An item
 * the owner set before anything else decided it stays as it is: its next
 * listing decides it.
 */
function restoreClearedOverride(set: TieredStoreSet, record: TierLedgerRecord): boolean {
  const ledger = set.ledger;
  const identity = identityOf(record);
  const before = ledger.settledDecisionBeforeOverride(identity);
  if (!before || before.metadataTier === 'secrets' || before.contentTier === 'secrets') return false;
  // Rules that cannot be trusted now: wait, rather than restore without them.
  const classification = set.classification();
  if (!classification || classification.unavailableReason) return false;
  const rules = classification.rules ?? [];
  const raising = rules.filter((rule) => tierRank(rule.tier) > tierRank('private'));
  const copies = ledger.copies(identity);
  const exported = storedCopyOf(set, identity, copies);
  // Names that cannot be read back from an item that has copies: the next pass tries again.
  if (!exported && copies.length > 0 && raising.length > 0) return false;
  const stored = exported ? storedSignals(exported) : {};
  const matched = raising.filter((rule) => rule.match.kind !== 'label' && ownerRuleMatches(rule, stored, record.provider));
  // Label rules for this item's source: whether the item carries the label is not known here.
  const labelRules = raising.filter((rule) => rule.match.kind === 'label'
    && ownerRuleMatches(rule, { labels: [rule.match.value] }, record.provider));
  const heldNow = maxTier(record.metadataTier, record.contentTier);
  let ruleTier: TierKey = matched.reduce<TierKey>((tier, rule) => maxTier(tier, rule.tier), 'public');
  for (const rule of labelRules) ruleTier = maxTier(ruleTier, minTier(rule.tier, heldNow));
  const metadataTier = maxTier(before.metadataTier, ruleTier);
  const contentTier = maxTier(before.contentTier, metadataTier);
  const byRule = tierRank(metadataTier) > tierRank(before.metadataTier);
  let ruleReasons: string[] = [];
  if (byRule) {
    // The rules' reason codes exactly as a listing states them.
    const classified = classifyItemTiers(
      {
        signals: { ...stored, ...(labelRules.length > 0 ? { labels: labelRules.map((rule) => rule.match.value) } : {}) },
        provider: record.provider,
        subject: identity,
      },
      { rules: [...rules], ...(classification.retirePublic ? { retirePublic: true } : {}) },
    );
    ruleReasons = classified.reasons.filter((reason) => reason.startsWith('metadata:owner_rule:'));
  }
  const decision: TierDecision = {
    metadataTier,
    contentTier,
    // A stored decider outside the classifier's own list (a landed move) is kept as recorded.
    decidedBy: byRule ? 'owner_rule' : before.decidedBy as TierDecision['decidedBy'],
    reasons: byRule
      ? [...ruleReasons, ...before.reasons.filter((reason) => reason.startsWith('content:'))]
      : [...before.reasons],
    state: 'current',
    contentRead: before.reasons.some((reason) => reason.startsWith('content:')),
    metadataPending: false,
    contentPending: false,
    metadataForced: before.reasons.some((reason) => reason.startsWith('metadata:') && reason.endsWith(':force'))
      || (byRule && matched.some((rule) => rule.strength === 'force')),
    metadataFlagged: before.reasons.some((reason) => reason.startsWith('metadata:possibly_private:')),
    engineVersion: record.engineVersion,
    mapRevision: record.mapRevision,
    snifferId: '',
  };
  const guard = { generation: record.generation, override: undefined };
  if (metadataTier === 'secrets') {
    return exported !== undefined
      && settleRoutedSecrets(set, identity, decision, exported, { findingKinds: ['owner_marked_secret'] }, { guard });
  }
  const recorded = ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision), {
    guard,
    staleCopiesGone: set.routedWithoutAnyCopy(identity),
  });
  return recorded.outcome !== 'unchanged';
}

function minTier(a: TierKey, b: TierKey): TierKey {
  return tierRank(a) <= tierRank(b) ? a : b;
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
  // Exactly the decision a listing makes for an overridden item. The owner's
  // tier wins; a lane hold is kept in the reasons for the passes after it.
  const holdUntilJudged = set.holdsContentUntilJudged() || heldUntilJudged(record.reasons);
  const decision: TierDecision = classifyItemTiers(
    { signals: {}, provider: record.provider, subject: identity, ...(holdUntilJudged ? { holdUntilJudged: true } : {}) },
    { override: { kind: 'tier', tier }, ...(retirePublic ? { retirePublic: true } : {}) },
  );
  const secrets = decision.contentTier === 'secrets';
  if (record.state === 'moving' && !secrets) {
    // A move in flight toward tiers less private than the owner's is
    // invalidated and retargeted; copies below the owner's tier are hidden
    // even when the move's target already matches (one ledger write). Any
    // other move lands first and the override applies after it.
    const outcome = ledger.queueOwnerRaise(identity, decision, leastPrivateDomain(set, decision), { guard });
    if (outcome !== 'none') report.raised += 1;
    else if (record.targetMetadataTier !== decision.metadataTier || record.targetContentTier !== decision.contentTier) report.heldMoving += 1;
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
    // No stored copy to read the location from: hidden all the same, and
    // forgotten by the side stores.
    if (ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision), { guard }).outcome === 'secrets') {
      forgetSecretInSideStores({ ledger, identity });
      // Nothing stored is left to tombstone (an earlier settlement got that
      // far): under tombstone_now its copy rows go too.
      if (secretsDisposition() === 'tombstone_now') ledger.removeCopies(identity);
      report.secrets += 1;
    }
    return;
  }
  const placement = set.placementFor(decision);
  const source = copyServingLayer(ledger.copies(identity).filter(copy => copy.state === 'current'), 'content');
  const destination = copyServingLayer(placement.copies, 'content');
  if (source && destination && trustDomainRank(destination.trustDomain) < trustDomainRank(source.trustDomain)) {
    // The owner authorizes this item's stored body. Bind that exact snapshot
    // too: no re-list is needed, and a later changed body cannot borrow it.
    const exported = set.store(source.trustDomain)?.exportItemCopy(identity);
    if (exported) decision.reasons.push(contentDigestReason(exported.chunks.map(chunk => chunk.boundedText).join('')));
  }
  // A Secret whose copies were tombstoned has nothing to move: its new
  // placement is recorded afresh (served once its next listing writes it).
  const recorded = ledger.recordRoutedPlacement(identity, decision, placement, {
    guard,
    staleCopiesGone: set.routedWithoutAnyCopy(identity),
  });
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
export function leastPrivateDomain(set: TieredStoreSet, decision: TierDecision): SourceTrustDomain {
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
