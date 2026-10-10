// Owner rules that RAISE (an "always Private" folder, label or sender from the
// privacy profile, or any owner tier rule to Private or Secrets) applied to
// items already stored (review fix 2026-10-02). Source-agnostic: it reads
// only the tier ledger and the names each item's store keeps.
//
// Rules used to apply only when a lane listed an item again, and an
// incremental listing never re-lists an unchanged item: an owner who marked
// a folder always Private kept its existing files Personal. When the set of
// raising rules changes, this pass reads every routed item's stored names
// once (a bounded page per call, resumed from the ledger), and an item a NEW
// raising rule matches is raised at once, hidden first (`recordRoutedPlacement`
// queues the raise and supersedes its current copies in the same write).
// Protection increases need nobody's approval; a rule that would LOWER an
// item never acts here (that waits for the item's next listing, as before).
//
// What a store keeps is what is matched: the title, a path-shaped locator,
// the stored scope and chat keys, and the sender. Facts a store does not keep
// (labels, sharing state) are matched at the item's next listing.

import { createHash } from 'node:crypto';
import {
  classifyItemTiers,
  maxTier,
  ownerRuleMatches,
  tierRank,
  type OwnerTierRule,
  type TierDecision,
  type TierKey,
} from '../classification/tier-classifier.ts';
import {
  copyServingLayer,
  type TierLedgerIdentity,
  type TierLedgerRecord,
} from '../classification/tier-ledger.ts';
import type { SourceClassificationSignals } from '../../core/contracts.ts';
import type { ConnectorStoreItemCopy } from './local-index.ts';
import { settleRoutedSecrets } from './tier-rejudge.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

/** Routed ledger rows read per call. */
export const DEFAULT_RULES_SWEEP_ROWS = 1_000;
const SWEEP_META_KEY = 'owner_rules_sweep';

export interface TierRulesSweepReport {
  /** Routed rows read this call. */
  scanned: number;
  /** Items a new raising rule matched that were raised (a queued raise hides first; same stores: updated in place). */
  raised: number;
  /** Items an owner rule made Secrets: hidden and handed to the Secrets policy. */
  secrets: number;
  /** Whether the sweep for the current raising rules is complete. */
  complete: boolean;
}

interface SweepState {
  /** Raising rules every routed item was checked against. */
  done: string[];
  /** A sweep in progress: the rules it checks and where it stopped. */
  pending?: { rules: string[]; after?: TierLedgerIdentity } | undefined;
}

export function sweepOwnerRuleRaises(options: { set: TieredStoreSet; limit?: number }): TierRulesSweepReport {
  const report: TierRulesSweepReport = { scanned: 0, raised: 0, secrets: 0, complete: true };
  const { set } = options;
  const classification = set.classification();
  // Unusable rules or map: a sync already holds every new decision pending;
  // nothing is judged from rules that cannot be trusted.
  if (!classification || classification.unavailableReason) return report;
  const ledger = set.ledger;
  const raising = (classification.rules ?? []).filter(isRaisingRule);
  const keyed = new Map(raising.map((rule) => [ruleKey(rule), rule]));
  const state = readState(ledger.readMeta(SWEEP_META_KEY));
  // A removed rule is forgotten, so adding it back sweeps again.
  const done = state.done.filter((key) => keyed.has(key));
  const pendingKeys = [...keyed.keys()].filter((key) => !done.includes(key)).sort();
  if (pendingKeys.length === 0) {
    if (done.length !== state.done.length || state.pending) writeState(ledger, { done });
    return report;
  }
  const pendingRules = pendingKeys.map((key) => keyed.get(key)!);
  const resume = state.pending && sameKeys(state.pending.rules, pendingKeys) ? state.pending.after : undefined;
  const limit = Math.max(1, options.limit ?? DEFAULT_RULES_SWEEP_ROWS);
  const rows = ledger.listRouted({ ...(resume ? { after: resume } : {}), limit });
  for (const record of rows) {
    report.scanned += 1;
    try {
      raiseIfMatched(set, record, pendingRules, classification);
    } catch {
      // Left as it was; the item's next listing applies the rule.
      continue;
    }
  }
  if (rows.length < limit) {
    writeState(ledger, { done: [...done, ...pendingKeys] });
  } else {
    report.complete = false;
    writeState(ledger, { done, pending: { rules: pendingKeys, after: identityOf(rows.at(-1)!) } });
  }
  return report;

  function raiseIfMatched(
    set: TieredStoreSet,
    record: TierLedgerRecord,
    rules: readonly OwnerTierRule[],
    inputs: NonNullable<ReturnType<TieredStoreSet['classification']>>,
  ): void {
    if (record.state === 'moving' || record.contentTier === 'secrets' || record.metadataTier === 'secrets') return;
    const identity = identityOf(record);
    if (set.ledger.getOverride(identity)) return;
    const current = set.ledger.copies(identity).filter((copy) => copy.state === 'current');
    const names = copyServingLayer(current, 'metadata');
    const domain = names ? set.domainForCorpus(names.corpusId) : undefined;
    const exported = domain ? set.store(domain)?.exportItemCopy(identity) : undefined;
    if (!exported) return;
    const signals = storedSignals(exported);
    const matched = rules.filter((rule) => ownerRuleMatches(rule, signals, record.provider));
    if (matched.length === 0) return;
    const ruleTier = matched.reduce<TierKey>((tier, rule) => maxTier(tier, rule.tier), 'public');
    const metadataTier = maxTier(record.metadataTier, ruleTier);
    // Only a raise acts here; content is never below the names.
    if (tierRank(metadataTier) <= tierRank(record.metadataTier)) return;
    // The names' reason codes exactly as a listing states them.
    const classified = classifyItemTiers(
      { signals, provider: record.provider, subject: identity },
      {
        rules: [...(inputs.rules ?? [])],
        ...(inputs.retirePublic ? { retirePublic: true } : {}),
      },
    );
    const ruleReasons = classified.reasons.filter((reason) => reason.startsWith('metadata:owner_rule:'));
    const contentTier = maxTier(record.contentTier, metadataTier);
    const contentPending = record.contentPending && tierRank(contentTier) < tierRank('secure');
    const decision: TierDecision = {
      metadataTier,
      contentTier,
      decidedBy: 'owner_rule',
      reasons: [
        ...(ruleReasons.length > 0 ? ruleReasons : record.reasons.filter((reason) => !reason.startsWith('content:'))),
        ...record.reasons.filter((reason) => reason.startsWith('content:')),
      ],
      state: contentPending ? 'pending' : 'current',
      contentRead: record.contentRead,
      metadataPending: false,
      contentPending,
      metadataForced: record.metadataForced || matched.some((rule) => rule.strength === 'force'),
      metadataFlagged: record.metadataFlagged,
      engineVersion: record.engineVersion,
      mapRevision: record.mapRevision,
      snifferId: classified.snifferId,
    };
    if (metadataTier === 'secrets') {
      if (settleRoutedSecrets(set, identity, decision, exported, { findingKinds: ['owner_marked_secret'] })) report.secrets += 1;
      return;
    }
    set.ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision));
    report.raised += 1;
  }
}

/** A rule that can raise an item above Personal: always Private, or Secrets. */
function isRaisingRule(rule: OwnerTierRule): boolean {
  return tierRank(rule.tier) > tierRank('private');
}

function ruleKey(rule: OwnerTierRule): string {
  return createHash('sha256')
    .update(JSON.stringify([rule.id, rule.source ?? '', rule.match.kind, rule.match.value, rule.tier, rule.strength]))
    .digest('hex')
    .slice(0, 24);
}

/** The classifier's input from a stored copy: what the store keeps of the item's names. */
function storedSignals(copy: ConnectorStoreItemCopy): SourceClassificationSignals {
  const text = (value: string | number | null | undefined) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const title = text(copy.columns['title']);
  const locator = text(copy.columns['locator_uri']);
  const path = locator?.startsWith('/') ? locator : undefined;
  const sender = text(copy.columns['sender_label']) ?? text(copy.columns['sender_id']);
  let folderKeys: string[] = [];
  const keysJson = text(copy.columns['source_scope_folder_keys_json']);
  if (keysJson) {
    try {
      const parsed = JSON.parse(keysJson) as unknown;
      if (Array.isArray(parsed)) folderKeys = parsed.filter((key): key is string => typeof key === 'string');
    } catch {
      folderKeys = [];
    }
  }
  if (copy.identity.providerConversationId) folderKeys.push(copy.identity.providerConversationId);
  return {
    ...(title ? { title } : {}),
    ...(path ? { path } : {}),
    ...(folderKeys.length > 0 ? { folderKeys } : {}),
    ...(sender ? { sender } : {}),
  };
}

function readState(raw: string | undefined): SweepState {
  if (!raw) return { done: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<SweepState>;
    return {
      done: Array.isArray(parsed.done) ? parsed.done.filter((key): key is string => typeof key === 'string') : [],
      ...(parsed.pending && Array.isArray(parsed.pending.rules) ? { pending: parsed.pending as SweepState['pending'] } : {}),
    };
  } catch {
    return { done: [] };
  }
}

function writeState(ledger: TieredStoreSet['ledger'], state: SweepState): void {
  ledger.writeMeta(SWEEP_META_KEY, JSON.stringify(state));
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function identityOf(record: TierLedgerRecord): TierLedgerIdentity {
  return {
    provider: record.provider,
    accountScope: record.accountScope,
    providerItemId: record.providerItemId,
    ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
  };
}
