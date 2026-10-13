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
  type TierCopy,
  type TierLedgerIdentity,
  type TierLedgerRecord,
} from '../classification/tier-ledger.ts';
import type { SourceClassificationSignals } from '../../core/contracts.ts';
import type { ConnectorStoreItemCopy } from './local-index.ts';
import { leastPrivateDomain } from './tier-override-settle.ts';
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

/** What raising one routed item did. `deferred`: the rule could not be judged or acted on yet; try again. */
type RaiseOutcome = 'raised' | 'secrets' | 'unchanged' | 'deferred';

/**
 * Raises one routed item the given rules match, hidden first. Only a raise
 * acts (nothing is ever lowered here), an owner override or a Secrets row is
 * left alone, and `extraSignals` carries facts the store does not keep (a
 * provider's labels for the item).
 *
 * A move in flight does not exempt an item: its names are read from whichever
 * copy is stored (a raise that hid its sources leaves them in their stores),
 * and the move is made safe in one ledger write (`queueOwnerRaise`): a move
 * toward tiers below the rule's is retargeted, and a copy still served below
 * the rule's tier (a move queued without hiding) is hidden. Secrets outrank
 * any move. `deferred` is returned only when the rule could not be judged or
 * acted on now: names that cannot be read back from an item that has copies.
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
  const copies = set.ledger.copies(identity);
  const exported = storedCopyOf(set, identity, copies);
  const signals: SourceClassificationSignals = { ...(exported ? storedSignals(exported) : {}), ...extraSignals };
  const matched = rules.filter((rule) => ownerRuleMatches(rule, signals, record.provider));
  if (!exported) {
    // Names that cannot be read back: an item with copies is retried unless
    // every rule is a label rule the provider's labels already ruled out; one
    // with no copy at all is not searchable.
    if (copies.length === 0) return 'unchanged';
    return matched.length > 0 || rules.some((rule) => !isLabelRule(rule)) ? 'deferred' : 'unchanged';
  }
  if (matched.length === 0) return 'unchanged';
  const ruleTier = matched.reduce<TierKey>((tier, rule) => maxTier(tier, rule.tier), 'public');
  const metadataTier = maxTier(record.metadataTier, ruleTier);
  const moving = record.state === 'moving';
  // Only a raise acts here; content is never below the names. A move in
  // flight is judged by where it is going and what is served meanwhile.
  if (!moving && tierRank(metadataTier) <= tierRank(record.metadataTier)) return 'unchanged';
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
    // Secrets hide every copy, a move in flight included.
    return settleRoutedSecrets(set, identity, decision, exported, { findingKinds: ['owner_marked_secret'] })
      ? 'secrets'
      : 'unchanged';
  }
  if (moving) {
    return set.ledger.queueOwnerRaise(identity, decision, leastPrivateDomain(set, decision)) === 'none'
      ? 'unchanged'
      : 'raised';
  }
  set.ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision));
  return 'raised';
}

/**
 * The item's stored copy for its names: the copy serving them, else any other
 * (a raise in flight hides its sources but leaves them in their stores).
 */
function storedCopyOf(
  set: TieredStoreSet,
  identity: TierLedgerIdentity,
  copies: readonly TierCopy[],
): ConnectorStoreItemCopy | undefined {
  const names = copyServingLayer(copies.filter((copy) => copy.state === 'current'), 'metadata');
  const ordered = [
    ...(names ? [names] : []),
    ...copies.filter((copy) => copy !== names).sort((left, right) => Number(right.state === 'current') - Number(left.state === 'current')),
  ];
  for (const copy of ordered) {
    const domain = set.domainForCorpus(copy.corpusId);
    const exported = domain ? set.store(domain)?.exportItemCopy(identity) : undefined;
    if (exported) return exported;
  }
  return undefined;
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
  /** Label rules every labelled stored item was raised for (and, at the last recheck, still is). */
  done: string[];
  /**
   * Walks in progress, one per rule: the provider page to resume at, and
   * whether an item the rule could not act on yet was seen earlier in the walk.
   * Kept for applied rules too, so a recheck of a large label covers it over
   * successive runs instead of re-reading its first pages every time.
   */
  walks?: Record<string, { pageToken: string; deferred?: boolean }> | undefined;
}

/**
 * Applies raising label rules (an "always Private" label from the privacy
 * profile, or any owner label rule to Private or Secrets) to the items a
 * provider says carry the label. A store keeps no labels and an incremental
 * listing never re-lists an unchanged item, so the owner who marks a label
 * after the mail was stored would otherwise never see it applied.
 *
 * A rule is recorded as applied only after the provider answered every page
 * and every stored item it named was raised or already safe; a failure leaves
 * it pending and the next call retries (resuming at the last page read).
 * Progress is kept per provider account in the set ledger. Items stored from
 * here on are classified with their labels at listing.
 *
 * `recheck` also walks the rules already applied (a label can be put on stored
 * mail later). A walk that does not finish (the page bound, a provider
 * failure) or that leaves an item the rule could not act on makes that rule
 * pending again, so it is retried and reported until a walk finishes clean;
 * its page is kept, so the next recheck carries on from there.
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
  const walks = new Map(Object.entries(stored.walks ?? {}).filter(([key]) => keyed.has(key)));
  const save = () => {
    const state: LabelSweepState = {
      done: [...done].sort(),
      ...(walks.size > 0 ? { walks: Object.fromEntries([...walks].sort(([left], [right]) => (left < right ? -1 : 1))) } : {}),
    };
    const next = JSON.stringify(state);
    if (next === written || (written === undefined && done.size === 0 && walks.size === 0)) return;
    ledger.writeMeta(metaKey, next);
    written = next;
  };
  // Rules still pending first, then (on a recheck) the applied ones.
  const queue = [...keyed.keys()]
    .filter((key) => options.recheck === true || !done.has(key))
    .sort((left, right) => Number(done.has(left)) - Number(done.has(right)) || (left < right ? -1 : 1));
  let pagesLeft = Math.max(1, options.maxPages ?? DEFAULT_LABEL_SWEEP_PAGES);
  for (const key of queue) {
    if (pagesLeft <= 0) break;
    const rule = keyed.get(key)!;
    const resumed = walks.get(key);
    let pageToken = resumed?.pageToken;
    let deferred = resumed?.deferred === true;
    report.rules += 1;
    let finished = false;
    try {
      let firstPage = true;
      while (pagesLeft > 0) {
        pagesLeft -= 1;
        let page: Awaited<ReturnType<LabelledItemSource['listLabelled']>>;
        try {
          page = await source.listLabelled(rule.match.value, pageToken !== undefined ? { pageToken } : {});
        } catch (error) {
          // A refused resume token restarts the walk; any other failure keeps
          // the last good page so the next call picks up there.
          if (error instanceof LabelPageRejectedError && firstPage && resumed) walks.delete(key);
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
        walks.set(key, { pageToken, ...(deferred ? { deferred: true } : {}) });
        save();
      }
    } catch {
      // The provider could not answer: the rule is not (or no longer) applied,
      // the last page stays saved, and the next call retries.
    }
    if (!finished) {
      done.delete(key);
      save();
      break;
    }
    // Every page answered. An item the rule could not act on yet (a move it
    // could not settle) keeps the rule pending: the next call walks it again.
    if (deferred) done.delete(key);
    else done.add(key);
    walks.delete(key);
    save();
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
    const parsed = JSON.parse(raw) as { done?: unknown; walks?: unknown };
    const walks: Record<string, { pageToken: string; deferred?: boolean }> = {};
    if (parsed.walks && typeof parsed.walks === 'object' && !Array.isArray(parsed.walks)) {
      for (const [key, walk] of Object.entries(parsed.walks as Record<string, unknown>)) {
        const entry = walk as { pageToken?: unknown; deferred?: unknown } | null;
        if (entry && typeof entry.pageToken === 'string' && entry.pageToken) {
          walks[key] = { pageToken: entry.pageToken, ...(entry.deferred === true ? { deferred: true } : {}) };
        }
      }
    }
    return {
      done: Array.isArray(parsed.done) ? parsed.done.filter((key): key is string => typeof key === 'string') : [],
      ...(Object.keys(walks).length > 0 ? { walks } : {}),
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
    const parsed = JSON.parse(raw) as { done?: unknown; pending?: unknown };
    const pending = parsePending(parsed.pending);
    return {
      done: Array.isArray(parsed.done) ? parsed.done.filter((key): key is string => typeof key === 'string') : [],
      ...(pending ? { pending } : {}),
    };
  } catch {
    return { done: [] };
  }
}

/**
 * A pass in progress, or undefined when what was saved cannot be trusted (the
 * pass then starts over): a retry pass retries what it held, so one with
 * nothing held is not a pass that finished.
 */
function parsePending(value: unknown): SweepState['pending'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pending = value as { rules?: unknown; after?: unknown; held?: unknown; retry?: unknown; overflow?: unknown };
  if (!Array.isArray(pending.rules) || !pending.rules.every((key) => typeof key === 'string')) return undefined;
  if (pending.after !== undefined && !isIdentity(pending.after)) return undefined;
  if (pending.held !== undefined && (!Array.isArray(pending.held) || !pending.held.every(isIdentity))) return undefined;
  if (pending.retry !== undefined && pending.retry !== true) return undefined;
  if (pending.overflow !== undefined && pending.overflow !== true) return undefined;
  if (pending.retry === true && (!Array.isArray(pending.held) || pending.held.length === 0)) return undefined;
  return {
    rules: pending.rules as string[],
    ...(pending.after ? { after: pending.after as TierLedgerIdentity } : {}),
    ...(pending.held ? { held: pending.held as TierLedgerIdentity[] } : {}),
    ...(pending.retry === true ? { retry: true } : {}),
    ...(pending.overflow === true ? { overflow: true } : {}),
  };
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
