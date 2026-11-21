import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { withOwnerConfigLease } from '../../core/owner-config-read.ts';
import { isArchiveCorpusId } from '../../core/archive-formats.ts';
import { connectorLabelCapability, observedLabelValues } from '../../core/source-connector-labels.ts';
import { registeredInstalledTierClassification } from '../classification/installed-tier-classification-registry.ts';
import { ownerRuleMatches, tierRank, type OwnerTierRule, type TierKey, type ItemTierOverride } from '../classification/tier-classifier.ts';
import { copyServingLayer, labelSweepMetaKey, tierLedgerIdentityOfRecord, tierLedgerIdentityKey, type TierLedgerIdentity, tierMoveOverrideConflict, trustDomainRank, type TierCopyPlan, type TierLedgerRecord } from '../classification/tier-ledger.ts';
import { readDecisionRules, OLYMPUS_TIER_RULES_ENV, resolveTierRulesPath, tierRulesFileStamp } from '../classification/tier-rules.ts';
import { servingMetadataCopy, storedSignals } from './stored-names.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

export interface TierRulePolicy {
  revision: string;
  rules: readonly OwnerTierRule[];
  retirePublic: boolean;
  unavailable: boolean;
}

interface PolicyFence {
  rulesPath?: string;
  policy?: TierRulePolicy;
}

// A provider answer is available only during the synchronous move or repair that requested it.
interface CurrentLabels {
  identityKey: string;
  revision: string;
  generation: number;
  decidedAt: string;
  labels: readonly string[];
}
const currentLabels = new WeakMap<TieredStoreSet, CurrentLabels>();

export function mutableItemLabels(set: TieredStoreSet, provider: string): boolean {
  if (!connectorLabelCapability(provider)?.mutable) return false;
  const stores = set.openStores();
  return !stores.length || stores.some(store => !isArchiveCorpusId(store.corpusId, store.trustDomain));
}

export async function withCurrentMoveLabels<T>(set: TieredStoreSet, identity: TierLedgerIdentity, target: MoveTarget | undefined, work: () => T): Promise<T> {
  if (!set.readCurrentLabels || !mutableItemLabels(set, identity.provider)) return work();
  const policy = withTierRuleFence(set, () => currentTierRulePolicy(set));
  const rules = applicableProviderLabelRules(policy.rules, identity.provider);
  if (policy.unavailable || !rules.length) return work();
  const record = set.ledger.getCurrent(identity);
  if (!record) return work();
  const wanted = target ?? record;
  const copies = set.ledger.copies(identity);
  const sources = copies.filter(copy => copy.state === 'current' || (copy.state === 'superseded'
    && copy.supersededByGeneration === record.generation + 1));
  const destination = set.placementFor({ ...record, ...wanted, state: record.metadataPending || record.contentPending ? 'pending' : 'current' });
  const ceiling = loweringCeiling(record, wanted, sources, destination.copies);
  const override = set.ledger.getOverride(identity);
  if (!rules.some(rule => tierRank(rule.tier) > ceiling
    && (override?.kind !== 'tier' || rule.tier === 'secrets'))) return work();
  const names = servingNames(set, record);
  if (!names) return work();
  const reader = set.readCurrentLabels;
  const labels = await reader(names.identity);
  if (!labels || reader !== set.readCurrentLabels) return work();
  currentLabels.set(set, { identityKey: tierLedgerIdentityKey(identity), revision: policy.revision,
    generation: record.generation, decidedAt: record.decidedAt, labels });
  try { return work(); } finally { currentLabels.delete(set); }
}

const heldPolicyFences = new WeakMap<TieredStoreSet, PolicyFence>();

/** Keep the active rule files stable until the caller's outer transaction commits. */
export function withTierRuleFence<T>(set: TieredStoreSet, work: () => T): T {
  if (heldPolicyFences.has(set)) return work();
  const rulesPath = set.ownerRulesPath ?? registeredInstalledTierClassification()?.ownerTierRulesPath
    ?? (process.env[OLYMPUS_TIER_RULES_ENV] ? resolveTierRulesPath() : undefined);
  const paths = [...new Set([rulesPath, set.ownerRuleSource?.path].filter((path): path is string => !!path).map((path) => resolve(path)))].sort();
  const take = (index: number): T => {
    const path = paths[index];
    if (path) return withOwnerConfigLease(path, 'shared', () => take(index + 1));
    heldPolicyFences.set(set, rulesPath ? { rulesPath } : {});
    try {
      return work();
    } finally {
      heldPolicyFences.delete(set);
    }
  };
  return take(0);
}

/** The active policy snapshot for a synchronous fenced operation. */
export function currentTierRulePolicy(set: TieredStoreSet): TierRulePolicy {
  const fence = heldPolicyFences.get(set);
  if (!fence) throw new Error('Tier rule policy requires the rule fence.');
  if (fence.policy) return fence.policy;
  const source = set.ownerRuleSource?.read();
  const classification = set.classification(source);
  const stamp = fence.rulesPath ? tierRulesFileStamp({ path: fence.rulesPath }) : '';
  const direct = fence.rulesPath && fence.rulesPath !== registeredInstalledTierClassification()?.ownerTierRulesPath
    ? readDecisionRules(fence.rulesPath) : undefined;
  const unavailable = !!(classification?.unavailableReason || source?.unavailable || direct?.unavailable);
  const keyedRules = new Map<string, OwnerTierRule>();
  for (const rule of [...(classification?.rules ?? []), ...(direct?.rules ?? [])]) keyedRules.set(ruleKey(rule), rule);
  const keys = [...keyedRules.keys()].sort();
  const rules = keys.map((key) => keyedRules.get(key)!);
  const retirePublic = classification?.retirePublic === true;
  const revision = digest([stamp, source?.revision, keys]);
  fence.policy = { revision, rules, retirePublic, unavailable };
  return fence.policy;
}

type MoveTarget = { metadataTier: TierKey; contentTier: TierKey };
type MoveCopies = readonly Pick<TierCopyPlan, 'trustDomain' | 'layers'>[];

interface RuleAuthority {
  set: TieredStoreSet;
  record: TierLedgerRecord;
  target: MoveTarget;
  sources: MoveCopies;
  destination: MoveCopies;
  override: ItemTierOverride | undefined;
  policy: TierRulePolicy;
  ceiling: number;
  rules: readonly OwnerTierRule[];
  names: () => ReturnType<typeof servingNames>;
}

function servingNames(set: TieredStoreSet, record: TierLedgerRecord) {
  const identity = tierLedgerIdentityOfRecord(record);
  const copies = set.ledger.copies(identity);
  const source = servingMetadataCopy(copies, record);
  return source && set.store(source.trustDomain)?.exportItemNames(identity);
}

// Each applicable check must authorize the move. Read the names only for rules that need them.
const moveRuleChecks = {
  override: (a) => !tierMoveOverrideConflict(a.override, a.record, a.target, a.sources, a.destination),
  policy: (a) => !Number.isFinite(a.ceiling) || !a.policy.unavailable,
  publicTier: (a) => !a.policy.retirePublic || a.ceiling >= tierRank('private'),
  storedFields: (a) => {
    const rules = a.rules.filter(rule => rule.match.kind !== 'label');
    if (!rules.length) return true;
    const names = a.names();
    if (!names) return false;
    const signals = storedSignals(names);
    return !rules.some(rule => ownerRuleMatches(rule, signals, a.record.provider));
  },
  labels: (a) => labelRulesWithoutNonmatch(a.set, a.record, a.policy,
    applicableProviderLabelRules(a.rules, a.record.provider), a.names).length === 0,
} satisfies Record<string, (authority: RuleAuthority) => boolean>;

export type MoveRuleAuthorityEntry = keyof typeof moveRuleChecks;

const moveRuleRegistry = Object.values(moveRuleChecks);

function loweringCeiling(record: TierLedgerRecord, target: MoveTarget, sources: MoveCopies, destination: MoveCopies): number {
  let ceiling = Number.POSITIVE_INFINITY;
  for (const layer of ['metadata', 'content'] as const) {
    const from = copyServingLayer(sources, layer);
    const to = copyServingLayer(destination, layer);
    const fromTier = layer === 'metadata' ? record.metadataTier : record.contentTier;
    const toTier = layer === 'metadata' ? target.metadataTier : target.contentTier;
    if (to && (tierRank(toTier) < tierRank(fromTier)
      || (from ? trustDomainRank(to.trustDomain) < trustDomainRank(from.trustDomain) : trustDomainRank(to.trustDomain) < tierRank('secure')))) {
      ceiling = Math.min(ceiling, tierRank(toTier), trustDomainRank(to.trustDomain));
    }
  }
  return ceiling;
}

/** Current authority for each layer being lowered, including its actual trust domain. */
export function tierMoveRuleAuthorization(
  set: TieredStoreSet, record: TierLedgerRecord, target: MoveTarget, sources: MoveCopies, destination: MoveCopies,
): string | undefined {
  const policy = currentTierRulePolicy(set);
  const override = set.ledger.getOverride(tierLedgerIdentityOfRecord(record));
  const ceiling = loweringCeiling(record, target, sources, destination);
  const rules = policy.rules.filter(rule => tierRank(rule.tier) > ceiling
    && (rule.source === undefined || rule.source === record.provider)
    && (override?.kind !== 'tier' || rule.tier === 'secrets'));
  let stored: ReturnType<typeof servingNames>;
  const names = () => stored ??= servingNames(set, record);
  const authority = { set, record, target, sources, destination, override, policy, ceiling, rules, names };
  return moveRuleRegistry.every(check => check(authority)) ? policy.revision : undefined;
}

/** Label membership needs an observation only for providers that publish label signals. */
export function applicableProviderLabelRules(rules: readonly OwnerTierRule[], provider: string): OwnerTierRule[] {
  if (!connectorLabelCapability(provider)) return [];
  return rules.filter(rule => rule.match.kind === 'label'
    && ownerRuleMatches(rule, { labels: [rule.match.value] }, provider));
}

/** Keep matches and unresolved rules. A missing observation is never an empty label set. */
export function labelRulesWithoutNonmatch(
  set: TieredStoreSet, record: TierLedgerRecord, policy: TierRulePolicy, rules: readonly OwnerTierRule[],
  names = () => servingNames(set, record),
): readonly OwnerTierRule[] {
  if (rules.length === 0 || policy.unavailable) return rules;
  const { provider, accountScope, providerItemId } = record;
  const capability = connectorLabelCapability(provider);
  if (!capability) return rules;
  if (capability.proof === 'stored') {
    const raw = names()?.columns.classification_labels_json;
    if (typeof raw !== 'string') return rules;
    const stored = observedLabelValues(provider, raw);
    if (!stored) return rules;
    let labels = stored;
    if (mutableItemLabels(set, provider)) {
      const fresh = currentLabels.get(set);
      if (!fresh || fresh.identityKey !== tierLedgerIdentityKey(tierLedgerIdentityOfRecord(record))
        || fresh.revision !== policy.revision || fresh.generation !== record.generation || fresh.decidedAt !== record.decidedAt) return rules;
      labels = [...stored, ...fresh.labels];
    }
    return rules.filter(rule => ownerRuleMatches(rule, { labels }, provider));
  }
  const progress = readLabelState(set.ledger.readMeta(labelSweepMetaKey(provider, accountScope)));
  if (!labelSweepHasPolicy(progress, policy, provider, accountScope)) return rules;
  const itemKey = labelEvidenceItemKey(providerItemId);
  return rules.filter(rule => {
    const key = ruleKey(rule);
    const walkId = progress.completed?.[key];
    return !walkId || !progress.done.includes(key) || !!progress.walks?.[key]
      || set.ledger.labelRuleMatched(provider, accountScope, key, walkId, itemKey);
  });
}

export interface LabelSweepState {
  /** The effective policy read before requesting the provider's first page. */
  revision?: string;
  provider?: string;
  accountScope?: string;
  done: string[];
  /** Per-rule walk IDs whose positive item evidence is complete. */
  completed?: Record<string, string>;
  walks?: Record<string, { id: string; pageToken?: string; deferred?: boolean }>;
  order?: string[];
}

export function labelSweepHasPolicy(state: LabelSweepState, policy: TierRulePolicy, provider: string, accountScope: string): boolean {
  return state.revision === policy.revision && state.provider === provider && state.accountScope === accountScope;
}

export function readLabelState(raw: string | undefined): LabelSweepState {
  if (!raw) return { done: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<LabelSweepState>;
    const walks: NonNullable<LabelSweepState['walks']> = {};
    for (const [key, walk] of Object.entries(parsed.walks ?? {})) {
      if (walk && isWalkId(walk.id)) {
        walks[key] = {
          id: walk.id,
          ...(typeof walk.pageToken === 'string' && walk.pageToken ? { pageToken: walk.pageToken } : {}),
          ...(walk.deferred === true ? { deferred: true } : {}),
        };
      }
    }
    const completed = Object.fromEntries(Object.entries(parsed.completed ?? {}).filter(([, id]) => isWalkId(id)));
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
    return {
      ...(typeof parsed.revision === 'string' ? { revision: parsed.revision } : {}),
      ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
      ...(typeof parsed.accountScope === 'string' ? { accountScope: parsed.accountScope } : {}),
      done: strings(parsed.done),
      completed,
      walks,
      order: strings(parsed.order),
    };
  } catch {
    return { done: [] };
  }
}

function isWalkId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function ruleKey(rule: OwnerTierRule): string {
  return digest([rule.id, rule.source ?? '', rule.match.kind, rule.match.value, rule.tier, rule.strength]).slice(0, 24);
}

export function labelEvidenceItemKey(providerItemId: string): string {
  return digest(providerItemId);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
