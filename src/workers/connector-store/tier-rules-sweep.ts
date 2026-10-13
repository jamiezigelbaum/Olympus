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
// A rule is recorded as done only once no matching item was left behind: one
// whose move is in flight, or whose raise failed, is held and retried alone
// (a bounded list in the ledger) until the rule can act on it.
//
// What a store keeps is what is matched: the title, a path-shaped locator,
// the stored scope and chat keys, and the sender. Labels are not kept, and a
// mailbox provider never lists an item it already holds again, so a label rule
// cannot wait for "the next listing": the provider's own lane applies it by
// asking which items carry the label (sweepLabelRuleRaises, below). That pass
// keeps its own record and finishes a rule only once the provider has answered
// for every page; the stored-names pass above never completes one.

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
const LABEL_SWEEP_META_KEY = 'owner_rules_label_sweep';
/** Provider pages one label-rule call reads before it hands back (the rest resumes next call). */
export const DEFAULT_LABEL_SWEEP_PAGES = 20;

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

/** Held-back items remembered between calls; past this the whole pass is walked again instead. */
const MAX_HELD_ITEMS = 200;

interface SweepState {
  /** Raising rules every routed item was checked against. */
  done: string[];
  /**
   * A sweep in progress: the rules it checks and where it stopped. `held` are
   * the items a match could not be applied to yet (a move in flight, or a
   * failure); once the pass ends, only those are retried (`retry`), and the
   * rules count as done only when none is left. `overflow`: too many to
   * remember, so the whole pass is walked again.
   */
  pending?: {
    rules: string[];
    after?: TierLedgerIdentity;
    held?: TierLedgerIdentity[];
    retry?: boolean;
    overflow?: boolean;
  } | undefined;
}

export function sweepOwnerRuleRaises(options: { set: TieredStoreSet; limit?: number }): TierRulesSweepReport {
  const report: TierRulesSweepReport = { scanned: 0, raised: 0, secrets: 0, complete: true };
  const { set } = options;
  const classification = set.classification();
  // Unusable rules or map: a sync already holds every new decision pending;
  // nothing is judged from rules that cannot be trusted.
  if (!classification || classification.unavailableReason) return report;
  const ledger = set.ledger;
  // Label rules are not decidable from what a store keeps: they never count
  // as swept here (sweepLabelRuleRaises owns them).
  const raising = (classification.rules ?? []).filter((rule) => isRaisingRule(rule) && !isLabelRule(rule));
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
  const progress = state.pending && sameKeys(state.pending.rules, pendingKeys) ? state.pending : undefined;
  const held: TierLedgerIdentity[] = [...(progress?.held ?? [])];
  let overflow = progress?.overflow === true;
  // An item a matching rule could not be applied to yet (a move in flight, a
  // failure) is held for a retry: the rule is never recorded as done past it.
  const attempt = (record: TierLedgerRecord): void => {
    report.scanned += 1;
    let raised: RaiseOutcome;
    try {
      raised = raiseRoutedItem(set, record, pendingRules, classification);
    } catch {
      raised = 'deferred';
    }
    if (raised === 'raised') report.raised += 1;
    else if (raised === 'secrets') report.secrets += 1;
    else if (raised === 'deferred') {
      if (held.length < MAX_HELD_ITEMS) held.push(identityOf(record));
      else overflow = true;
    }
  };
  if (progress?.retry && !progress.overflow) {
    // The pass is over; only what it held back is tried again.
    const retrying = held.splice(0);
    for (const identity of retrying) {
      const record = ledger.getCurrent(identity);
      if (record?.routed) attempt(record);
    }
    if (held.length === 0) {
      writeState(ledger, { done: [...done, ...pendingKeys] });
    } else {
      report.complete = false;
      writeState(ledger, { done, pending: { rules: pendingKeys, held, retry: true } });
    }
    return report;
  }
  const resume = progress?.after;
  const limit = Math.max(1, options.limit ?? DEFAULT_RULES_SWEEP_ROWS);
  const rows = ledger.listRouted({ ...(resume ? { after: resume } : {}), limit });
  for (const record of rows) attempt(record);
  if (rows.length < limit) {
    if (held.length === 0 && !overflow) {
      writeState(ledger, { done: [...done, ...pendingKeys] });
    } else {
      report.complete = false;
      // Too many held to remember: the next call walks the whole pass again.
      writeState(ledger, overflow ? { done } : { done, pending: { rules: pendingKeys, held, retry: true } });
    }
  } else {
    report.complete = false;
    writeState(ledger, {
      done,
      pending: { rules: pendingKeys, after: identityOf(rows.at(-1)!), held, ...(overflow ? { overflow: true } : {}) },
    });
  }
  return report;
}

/** What raising one routed item did. `deferred`: a move in flight holds it, so the rule could not act yet. */
type RaiseOutcome = 'raised' | 'secrets' | 'unchanged' | 'deferred';

/**
 * Raises one routed item the given rules match, hidden first. Only a raise
 * acts (nothing is ever lowered here), an owner override or a Secrets row is
 * left alone, and `extraSignals` carries facts the store does not keep (a
 * provider's labels for the item).
 */
function raiseRoutedItem(
  set: TieredStoreSet,
  record: TierLedgerRecord,
  rules: readonly OwnerTierRule[],
  inputs: NonNullable<ReturnType<TieredStoreSet['classification']>>,
  extraSignals: Pick<SourceClassificationSignals, 'labels'> = {},
): RaiseOutcome {
  if (record.contentTier === 'secrets' || record.metadataTier === 'secrets') return 'unchanged';
  const identity = identityOf(record);
  if (set.ledger.getOverride(identity)) return 'unchanged';
  const current = set.ledger.copies(identity).filter((copy) => copy.state === 'current');
  const names = copyServingLayer(current, 'metadata');
  const domain = names ? set.domainForCorpus(names.corpusId) : undefined;
  const exported = domain ? set.store(domain)?.exportItemCopy(identity) : undefined;
  const signals: SourceClassificationSignals = { ...(exported ? storedSignals(exported) : {}), ...extraSignals };
  const matched = rules.filter((rule) => ownerRuleMatches(rule, signals, record.provider));
  if (matched.length === 0) return 'unchanged';
  const ruleTier = matched.reduce<TierKey>((tier, rule) => maxTier(tier, rule.tier), 'public');
  // A move in flight keeps its own decision: one already heading to this tier
  // is hidden and needs nothing; one heading elsewhere is raised once it lands.
  if (record.state === 'moving') {
    const heading = maxTier(record.metadataTier, record.targetMetadataTier ?? record.metadataTier);
    return tierRank(heading) >= tierRank(ruleTier) ? 'unchanged' : 'deferred';
  }
  // Names that cannot be read back: an item still served somewhere is retried,
  // one with no current copy is not searchable at all.
  if (!exported) return current.length > 0 ? 'deferred' : 'unchanged';
  const metadataTier = maxTier(record.metadataTier, ruleTier);
  // Only a raise acts here; content is never below the names.
  if (tierRank(metadataTier) <= tierRank(record.metadataTier)) return 'unchanged';
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
    return settleRoutedSecrets(set, identity, decision, exported, { findingKinds: ['owner_marked_secret'] })
      ? 'secrets'
      : 'unchanged';
  }
  set.ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision));
  return 'raised';
}

/** A provider's answer to "which of your items carry this label". */
export interface LabelledItemSource {
  /**
   * One bounded page of the provider's ids of items carrying `label`, from
   * `pageToken` when given. Throws when the provider cannot be asked (offline,
   * a token problem, a spent request budget); throws LabelPageRejectedError
   * when it refuses a resume token. A label the provider does not know has no
   * items: an empty page, not an error.
   */
  listLabelled(label: string, page: { pageToken?: string }): Promise<{ ids: readonly string[]; nextPageToken?: string }>;
}

/** The provider refused a saved resume token: the walk starts over. */
export class LabelPageRejectedError extends Error {
  constructor() {
    super('The provider no longer accepts the saved label page.');
    this.name = 'LabelPageRejectedError';
  }
}

export interface LabelRuleSweepReport {
  /** Label rules walked this call. */
  rules: number;
  /** Provider ids read this call. */
  scanned: number;
  /** Stored items a label rule raised (hidden first). */
  raised: number;
  /** Stored items a label rule made Secrets. */
  secrets: number;
  /** Raising label rules not yet applied to every stored item (a provider failure, the page bound, or a move in flight). */
  pending: number;
}

interface LabelSweepState {
  /** Label rules every labelled stored item was raised for. */
  done: string[];
  /** A walk in progress: the rule, the provider page to resume at, and whether a move in flight held an item back. */
  walk?: { rule: string; pageToken: string; deferred?: boolean } | undefined;
}

/**
 * Applies raising label rules (an "always Private" label from the privacy
 * profile, or any owner label rule to Private or Secrets) to the items a
 * provider says carry the label. A store keeps no labels and an incremental
 * listing never re-lists an unchanged item, so the owner who marks a label
 * after the mail was stored would otherwise never see it applied.
 *
 * A rule is recorded as applied only after the provider answered every page
 * and every stored item it named was raised or already at or above the rule's
 * tier; a failure leaves it pending and the next call retries (resuming at the
 * last page read). Progress is kept per provider account in the set ledger.
 * Items stored from here on are classified with their labels at listing.
 *
 * `recheck` also walks the rules already applied (a label can be put on stored
 * mail later): it resumes and records nothing for them, but a stored item it
 * cannot raise yet makes that rule pending again.
 */
export async function sweepLabelRuleRaises(options: {
  set: TieredStoreSet;
  provider: string;
  accountScope: string;
  source: LabelledItemSource;
  recheck?: boolean;
  maxPages?: number;
}): Promise<LabelRuleSweepReport> {
  const report: LabelRuleSweepReport = { rules: 0, scanned: 0, raised: 0, secrets: 0, pending: 0 };
  const { set, provider, accountScope, source } = options;
  const classification = set.classification();
  // Unusable rules or map: nothing is judged from rules that cannot be trusted.
  if (!classification || classification.unavailableReason) return report;
  const ledger = set.ledger;
  const keyed = new Map<string, OwnerTierRule>();
  for (const rule of classification.rules ?? []) {
    if (!isRaisingRule(rule) || !isLabelRule(rule)) continue;
    if (rule.source !== undefined && rule.source !== provider) continue;
    keyed.set(ruleKey(rule), rule);
  }
  const metaKey = `${LABEL_SWEEP_META_KEY}:${provider}:${accountScope}`;
  let written = ledger.readMeta(metaKey);
  const stored = readLabelState(written);
  // A removed rule is forgotten, so adding it back sweeps again.
  const done = new Set(stored.done.filter((key) => keyed.has(key)));
  let walk = stored.walk && keyed.has(stored.walk.rule) && !done.has(stored.walk.rule) ? stored.walk : undefined;
  const save = () => {
    const state: LabelSweepState = { done: [...done].sort(), ...(walk ? { walk } : {}) };
    const next = JSON.stringify(state);
    if (next === written || (written === undefined && done.size === 0 && !walk)) return;
    ledger.writeMeta(metaKey, next);
    written = next;
  };
  const queue = [...keyed.keys()].filter((key) => options.recheck === true || !done.has(key)).sort();
  let pagesLeft = Math.max(1, options.maxPages ?? DEFAULT_LABEL_SWEEP_PAGES);
  try {
    for (const key of queue) {
      if (pagesLeft <= 0) break;
      const rule = keyed.get(key)!;
      const wasPending = !done.has(key);
      const resumed = wasPending && walk?.rule === key ? walk : undefined;
      let pageToken = resumed?.pageToken;
      let deferred = resumed?.deferred === true;
      report.rules += 1;
      let finished = false;
      let firstPage = true;
      while (pagesLeft > 0) {
        pagesLeft -= 1;
        let page: Awaited<ReturnType<LabelledItemSource['listLabelled']>>;
        try {
          page = await source.listLabelled(rule.match.value, pageToken !== undefined ? { pageToken } : {});
        } catch (error) {
          // A refused resume token restarts the walk; any other failure keeps
          // the last good page so the next call picks up there.
          if (error instanceof LabelPageRejectedError && firstPage && resumed) walk = undefined;
          throw error;
        }
        firstPage = false;
        for (const id of page.ids) {
          report.scanned += 1;
          const outcome = raiseLabelled(set, { provider, accountScope, providerItemId: id }, rule, classification);
          if (outcome === 'raised') report.raised += 1;
          else if (outcome === 'secrets') report.secrets += 1;
          else if (outcome === 'deferred') deferred = true;
        }
        pageToken = page.nextPageToken || undefined;
        if (pageToken === undefined) {
          finished = true;
          break;
        }
        if (wasPending) {
          walk = { rule: key, pageToken, ...(deferred ? { deferred: true } : {}) };
          save();
        }
      }
      if (!finished) break;
      // Every page answered. An item a move in flight held back keeps the rule
      // pending: the next call walks it again once the move has landed.
      if (deferred) done.delete(key);
      else done.add(key);
      if (walk?.rule === key) walk = undefined;
      save();
    }
  } catch {
    // The provider could not answer: the rule stays pending and the next call retries.
  }
  save();
  report.pending = [...keyed.keys()].filter((key) => !done.has(key)).length;
  return report;
}

/** Raises one stored item the provider says carries the rule's label. Never throws; an item it could not settle is `deferred`. */
function raiseLabelled(
  set: TieredStoreSet,
  identity: TierLedgerIdentity,
  rule: OwnerTierRule,
  classification: NonNullable<ReturnType<TieredStoreSet['classification']>>,
): RaiseOutcome {
  try {
    const record = set.ledger.getCurrent(identity);
    // Not stored here (or stored before routing): a listing classifies it with its labels.
    if (!record || !record.routed) return 'unchanged';
    return raiseRoutedItem(set, record, [rule], classification, { labels: [rule.match.value] });
  } catch {
    return 'deferred';
  }
}

function readLabelState(raw: string | undefined): LabelSweepState {
  if (!raw) return { done: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<LabelSweepState>;
    const walk = parsed.walk;
    return {
      done: Array.isArray(parsed.done) ? parsed.done.filter((key): key is string => typeof key === 'string') : [],
      ...(walk && typeof walk.rule === 'string' && typeof walk.pageToken === 'string'
        ? { walk: { rule: walk.rule, pageToken: walk.pageToken, ...(walk.deferred === true ? { deferred: true } : {}) } }
        : {}),
    };
  } catch {
    return { done: [] };
  }
}

/** A label rule: matched against the provider's labels for an item, which no store keeps. */
function isLabelRule(rule: OwnerTierRule): boolean {
  return rule.match.kind === 'label';
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
    const pending = parsed.pending;
    return {
      done: Array.isArray(parsed.done) ? parsed.done.filter((key): key is string => typeof key === 'string') : [],
      ...(pending && Array.isArray(pending.rules)
        ? {
            pending: {
              rules: pending.rules,
              ...(pending.after ? { after: pending.after } : {}),
              ...(Array.isArray(pending.held) ? { held: pending.held.filter(isIdentity) } : {}),
              ...(pending.retry === true ? { retry: true } : {}),
              ...(pending.overflow === true ? { overflow: true } : {}),
            },
          }
        : {}),
    };
  } catch {
    return { done: [] };
  }
}

function isIdentity(value: unknown): value is TierLedgerIdentity {
  const record = value as Partial<TierLedgerIdentity> | null;
  return typeof record === 'object' && record !== null
    && typeof record.provider === 'string' && typeof record.accountScope === 'string' && typeof record.providerItemId === 'string'
    && (record.providerConversationId === undefined || typeof record.providerConversationId === 'string');
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
