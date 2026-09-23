// Shared, source-agnostic four-tier classifier (design:
// docs/design/per-item-four-tier-classification.md, section 2.2).
//
// Every item gets TWO tiers:
// - a metadata tier for its names (title, path, folders, sender, labels),
//   Personal by default; and
// - a content tier for its text, which starts at the metadata tier and can
//   only be RAISED (unless the owner overrides the item).
//
// Invariants, each pinned by test/tier-classifier.test.ts:
// - Raises beat lowers. The most sensitive positive verdict wins; a lowering
//   signal never rescues an item a raising signal flagged.
// - Secrets outrank everything except an explicit per-item owner override.
// - Public needs positive evidence (a public link, a published item, an owner
//   rule or a map category). Absence of sensitive signals is never enough.
// - The classifier reads SIGNAL KINDS only. It never branches on which source
//   an item came from; test/tier-classifier-source-agnostic.test.ts enforces it.
// - Reasons are content-free codes: finding kinds, fixed vocabulary families,
//   owner rule and map category ids. Never a title, path, sender or text.
// - Deterministic. The privacy-safe sniffer is a seam (TierSniffer); the only
//   implementation shipped in this phase answers "undecided", which leaves the
//   tier where the deterministic steps put it and marks the item pending.

import type {
  SourceClassificationSignals,
  SourceClassificationTier,
} from '../../core/contracts.ts';
import {
  matchSensitivityMapTiers,
  sensitivityMapRevision,
  type SensitivityMap,
} from '../../core/sensitivity-map.ts';
import {
  detectSecretFindingKinds,
  detectSensitiveContent,
  namesLookPossiblyPrivate,
} from './engine.ts';

export const TIER_CLASSIFIER_KIND = 'olympus_shared_four_tier_classifier';
export const TIER_CLASSIFIER_VERSION = '2026-09-23.p1a';

export type TierKey = SourceClassificationTier;

export const TIER_KEYS: readonly TierKey[] = ['public', 'private', 'secure', 'secrets'];

const TIER_RANK: Readonly<Record<TierKey, number>> = {
  public: 0,
  private: 1,
  secure: 2,
  secrets: 3,
};

export function tierRank(tier: TierKey): number {
  return TIER_RANK[tier];
}

export function maxTier(a: TierKey, b: TierKey): TierKey {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

// --- Owner configuration ------------------------------------------------------

/**
 * An owner folder / label / sender / chat rule (design section 2.4). Loading
 * rules from `~/.olympus/tier-rules.json` is phase P2; the classifier already
 * honours them so the precedence is fixed before any rule file exists.
 *
 * `source` is matched as an opaque string against the item's provider, which
 * is data the owner wrote, not a branch in code. `chat` rules match a
 * conversation's key, which chat connectors publish in `folderKeys`.
 */
export interface OwnerTierRule {
  id: string;
  source?: string;
  match:
    | { kind: 'pathPrefix'; value: string }
    | { kind: 'folderKey'; value: string }
    | { kind: 'label'; value: string }
    | { kind: 'sender'; value: string }
    | { kind: 'chat'; value: string };
  tier: TierKey;
  strength: 'prior' | 'force';
}

/**
 * A per-item owner override, stored in the tier ledger and keyed by provider
 * identity so it survives re-syncs and moves.
 *
 * - `tier`: the item's tier, final for both layers.
 * - `not_secret`: clears the secret detectors for this item and sends it back
 *   through normal classification. It never jumps straight to a tier.
 */
export type ItemTierOverride =
  | { kind: 'tier'; tier: TierKey }
  | { kind: 'not_secret' };

// --- Sniffer seam -------------------------------------------------------------

export interface TierSnifferRequest {
  pass: 'metadata' | 'content';
  /** Content-free reason the item was flagged, e.g. `names:health`. */
  flags: readonly string[];
}

/**
 * The privacy-safe model seam (design section 2.2, steps 7 and 12). P2 plugs
 * in a local or Venice Private model here. It may answer only Personal or
 * Private, or `undecided`. It is never asked about an item the secret detector
 * caught, and never asked when the deterministic tier is already Private.
 */
export type TierSnifferVerdict =
  | { verdict: 'undecided' }
  | { verdict: 'decided'; tier: 'private' | 'secure'; code: string };

export interface TierSniffer {
  readonly id: string;
  judge(request: TierSnifferRequest): TierSnifferVerdict;
}

/** The only sniffer in this phase: it never decides, so flagged items stay pending. */
export const UNDECIDED_TIER_SNIFFER: TierSniffer = Object.freeze({
  id: 'undecided',
  judge: (): TierSnifferVerdict => ({ verdict: 'undecided' }),
});

// --- Input / output -----------------------------------------------------------

export interface TierClassificationInput {
  signals: SourceClassificationSignals;
  /**
   * The item's provider, used ONLY to match owner rules that name a source.
   * Never compared against a literal in this module.
   */
  provider?: string;
  /** Full extracted text for pass 2. Absent means pass 2 has nothing to read. */
  text?: string;
}

export interface TierClassificationOptions {
  sensitivityMap?: SensitivityMap;
  rules?: readonly OwnerTierRule[];
  override?: ItemTierOverride;
  sniffer?: TierSniffer;
}

export type TierDecisionState = 'pending' | 'current';

export interface TierDecision {
  metadataTier: TierKey;
  contentTier: TierKey;
  /** Which step settled the content tier (the layer that governs the text). */
  decidedBy: TierDecidedBy;
  /** Content-free reason codes, metadata reasons first. */
  reasons: string[];
  /** `pending` while a sniffer question is unanswered. */
  state: TierDecisionState;
  /** Whether pass 2 read any text. */
  contentRead: boolean;
  engineVersion: string;
  mapRevision: string;
  snifferId: string;
}

export type TierDecidedBy =
  | 'override'
  | 'secret_detector'
  | 'owner_rule'
  | 'source_floor'
  | 'source_prior'
  | 'sensitivity_map'
  | 'public_evidence'
  | 'sensitive_detector'
  | 'sniffer'
  | 'default';

// --- Classifier ----------------------------------------------------------------

export function classifyItemTiers(
  input: TierClassificationInput,
  options: TierClassificationOptions = {},
): TierDecision {
  const signals = input.signals;
  const sniffer = options.sniffer ?? UNDECIDED_TIER_SNIFFER;
  const base = {
    engineVersion: TIER_CLASSIFIER_VERSION,
    mapRevision: sensitivityMapRevision(options.sensitivityMap),
    snifferId: sniffer.id,
  };
  const text = input.text?.trim() ? input.text : undefined;

  // [1] Per-item owner override (sticky). A tier override is final for both
  // layers — including over Secrets, which is the one thing that may.
  if (options.override?.kind === 'tier') {
    return {
      ...base,
      metadataTier: options.override.tier,
      contentTier: options.override.tier,
      decidedBy: 'override',
      reasons: [`override:item:${options.override.tier}`],
      state: 'current',
      contentRead: text !== undefined,
    };
  }
  const secretsCleared = options.override?.kind === 'not_secret';
  const clearedReason = secretsCleared ? ['override:item:not_secret'] : [];

  const names = namesOf(signals);
  const matchInput = mapMatchInput(signals);

  // ---------------------------------------------------------------- pass 1 --
  const metadata = metadataPass({ signals, provider: input.provider, names, matchInput, options, secretsCleared, sniffer });

  // ---------------------------------------------------------------- pass 2 --
  const content = contentPass({
    signals,
    text,
    matchInput,
    metadata,
    options,
    secretsCleared,
    sniffer,
  });

  return {
    ...base,
    metadataTier: metadata.tier,
    contentTier: content.tier,
    decidedBy: content.decidedBy,
    reasons: [...clearedReason, ...metadata.reasons, ...content.reasons],
    state: metadata.pending || content.pending ? 'pending' : 'current',
    contentRead: text !== undefined,
  };
}

interface PassResult {
  tier: TierKey;
  decidedBy: TierDecidedBy;
  reasons: string[];
  pending: boolean;
  /** Set when a force rule fixed the tier: pass 2 may then raise only to Secrets. */
  forced: boolean;
  /** Pass-1 sniffer flags, handed to pass 2. */
  flags: string[];
}

function metadataPass(args: {
  signals: SourceClassificationSignals;
  provider: string | undefined;
  names: string;
  matchInput: MapMatchInput;
  options: TierClassificationOptions;
  secretsCleared: boolean;
  sniffer: TierSniffer;
}): PassResult {
  const { signals, names, options } = args;

  // [2] Secret detector on title + path. Nothing but an override outranks it.
  if (!args.secretsCleared) {
    const secretKinds = detectSecretFindingKinds([signals.title, signals.path].filter(Boolean).join('\n'));
    if (secretKinds.length > 0) {
      return {
        tier: 'secrets',
        decidedBy: 'secret_detector',
        reasons: secretKinds.map((kind) => `metadata:secret:${kind}`),
        pending: false,
        forced: false,
        flags: [],
      };
    }
  }

  const raises: Verdict[] = [];
  const lowers: Verdict[] = [];
  let resting: Verdict = { tier: 'private', decidedBy: 'default', reason: 'metadata:default:personal' };
  let restingIsConfigured = false;

  // [3] Owner rules. force beats prior; among equals the most sensitive wins.
  const matchedRules = (options.rules ?? []).filter((rule) => ownerRuleMatches(rule, signals, args.provider));
  const forceRule = mostSensitive(matchedRules.filter((rule) => rule.strength === 'force'));
  if (forceRule) {
    return {
      tier: forceRule.tier,
      decidedBy: 'owner_rule',
      reasons: [`metadata:owner_rule:${forceRule.match.kind}:${forceRule.id}:force`],
      pending: false,
      forced: true,
      flags: [],
    };
  }
  const priorRule = mostSensitive(matchedRules.filter((rule) => rule.strength === 'prior'));

  // A source-level force prior behaves like a force rule.
  if (signals.prior?.strength === 'force' && !priorRule) {
    return {
      tier: signals.prior.tier === 'secrets' ? 'secure' : signals.prior.tier,
      decidedBy: 'source_prior',
      reasons: [`metadata:prior:${signals.prior.basis}:force`],
      pending: false,
      forced: true,
      flags: [],
    };
  }

  if (priorRule) {
    resting = { tier: priorRule.tier, decidedBy: 'owner_rule', reason: `metadata:owner_rule:${priorRule.match.kind}:${priorRule.id}:prior` };
    restingIsConfigured = true;
  } else if (signals.prior) {
    resting = { tier: signals.prior.tier, decidedBy: 'source_prior', reason: `metadata:prior:${signals.prior.basis}` };
    restingIsConfigured = true;
  }
  // A configured Secrets resting tier is honoured as Private for the NAMES:
  // Secrets are location-only and a prior is not a secret finding.
  if (resting.tier === 'secrets') resting = { ...resting, tier: 'secure' };

  // [4] Source floor (a provider fact): always a raise.
  if (signals.floor) {
    raises.push({ tier: signals.floor.tier, decidedBy: 'source_floor', reason: `metadata:floor:${signals.floor.basis}` });
  }

  // [5] Sensitivity map v2 on the names. Raising and lowering categories.
  const mapMatches = matchSensitivityMapTiers(options.sensitivityMap, {
    ...(args.matchInput.title ? { title: args.matchInput.title } : {}),
    ...(args.matchInput.sender ? { sender: args.matchInput.sender } : {}),
    ...(args.matchInput.path ? { path: args.matchInput.path } : {}),
  });
  for (const match of mapMatches) {
    const verdict: Verdict = {
      tier: match.tierName,
      decidedBy: 'sensitivity_map',
      reason: `metadata:sensitivity_map:${match.categoryId}`,
    };
    if (tierRank(match.tierName) > tierRank(resting.tier)) raises.push(verdict);
    else lowers.push(verdict);
  }

  // [6] Deterministic public evidence.
  if (signals.sharing === 'public_link' || signals.sharing === 'published') {
    lowers.push({ tier: 'public', decidedBy: 'public_evidence', reason: `metadata:evidence:${signals.sharing}` });
  }

  let decided = resolveVerdicts(resting, raises, lowers, restingIsConfigured);

  // [7] Sniffer, only when names look possibly private, nothing already made
  // the names Private, and no owner map category already spoke for them.
  const flags = mapMatches.length > 0 ? [] : namesLookPossiblyPrivate(names).map((family) => `names:${family}`);
  let pending = false;
  if (flags.length > 0 && tierRank(decided.tier) < tierRank('secure')) {
    const verdict = args.sniffer.judge({ pass: 'metadata', flags });
    if (verdict.verdict === 'decided') {
      decided = maxVerdict(decided, { tier: verdict.tier, decidedBy: 'sniffer', reason: `metadata:sniffer:${args.sniffer.id}:${verdict.code}` });
    } else {
      pending = true;
    }
  }

  const reasons = [...new Set([
    ...decided.reasons,
    ...(pending ? flags.map((flag) => `metadata:possibly_private:${flag}`) : []),
    ...(pending ? [`metadata:sniffer:${args.sniffer.id}:undecided`] : []),
  ])];

  // [8] The default is already the resting verdict when nothing else applied.
  return { tier: decided.tier, decidedBy: decided.decidedBy, reasons, pending, forced: false, flags };
}

function contentPass(args: {
  signals: SourceClassificationSignals;
  text: string | undefined;
  matchInput: MapMatchInput;
  metadata: PassResult;
  options: TierClassificationOptions;
  secretsCleared: boolean;
  sniffer: TierSniffer;
}): { tier: TierKey; decidedBy: TierDecidedBy; reasons: string[]; pending: boolean } {
  const { metadata, text } = args;
  if (metadata.tier === 'secrets') {
    // The whole item is Secrets (design 2.3, beta 4 unit). Pass 2 never runs,
    // so no text of a secret-bearing item is scanned further or excerpted.
    return { tier: 'secrets', decidedBy: metadata.decidedBy, reasons: [], pending: false };
  }
  if (text === undefined) {
    return {
      tier: metadata.tier,
      decidedBy: metadata.decidedBy,
      reasons: ['content:unread'],
      pending: metadata.pending,
    };
  }

  // [9] Secret detector on the full text.
  if (!args.secretsCleared) {
    const secretKinds = detectSecretFindingKinds(text);
    if (secretKinds.length > 0) {
      return {
        tier: 'secrets',
        decidedBy: 'secret_detector',
        reasons: secretKinds.map((kind) => `content:secret:${kind}`),
        pending: false,
      };
    }
  }

  // A force rule fixes the tier; only Secrets (above) may still raise it.
  if (metadata.forced) {
    return { tier: metadata.tier, decidedBy: metadata.decidedBy, reasons: [], pending: false };
  }

  let decided: ResolvedVerdict = { tier: metadata.tier, decidedBy: metadata.decidedBy, reasons: [] };

  // [10] Deterministic sensitive detectors on the text. Names travel with the
  // text so the health origin hint and a title's vocabulary still count; the
  // content tier is at least the metadata tier, so this can only raise.
  const detection = detectSensitiveContent({
    text,
    ...(args.matchInput.title ? { title: args.matchInput.title } : {}),
    ...(args.matchInput.sender ? { sender: args.matchInput.sender } : {}),
    ...(args.matchInput.path ? { path: args.matchInput.path } : {}),
  });
  if (detection.signals.length > 0) {
    decided = maxVerdict(decided, {
      tier: 'secure',
      decidedBy: 'sensitive_detector',
      reasons: detectorReasons(detection.signals),
    });
  }

  // [11] Sensitivity map v2 on the text. Content only raises, so a lowering
  // category is ignored here.
  const mapMatches = matchSensitivityMapTiers(args.options.sensitivityMap, { text });
  for (const match of mapMatches) {
    if (tierRank(match.tierName) <= tierRank(decided.tier)) continue;
    decided = maxVerdict(decided, {
      tier: match.tierName,
      decidedBy: 'sensitivity_map',
      reason: `content:sensitivity_map:${match.categoryId}`,
    });
  }

  // [12] Sniffer on a short excerpt, only when pass 1 flagged the item or a
  // detector family came close, and only while the content is below Private.
  let pending = false;
  const flags = [
    ...metadata.flags,
    ...detection.borderline.map((family) => `content:borderline:${family}`),
  ];
  const reasons = [...decided.reasons];
  if (flags.length > 0 && tierRank(decided.tier) < tierRank('secure')) {
    const verdict = args.sniffer.judge({ pass: 'content', flags });
    if (verdict.verdict === 'decided') {
      decided = maxVerdict(decided, { tier: verdict.tier, decidedBy: 'sniffer', reason: `content:sniffer:${args.sniffer.id}:${verdict.code}` });
      reasons.splice(0, reasons.length, ...decided.reasons);
    } else {
      pending = true;
      for (const flag of detection.borderline) reasons.push(`content:borderline:${flag}`);
      reasons.push(`content:sniffer:${args.sniffer.id}:undecided`);
    }
  }
  if (reasons.length === 0) reasons.push('content:no_raise');
  return { tier: decided.tier, decidedBy: decided.decidedBy, reasons: [...new Set(reasons)], pending };
}

// --- Helpers ------------------------------------------------------------------

interface Verdict {
  tier: TierKey;
  decidedBy: TierDecidedBy;
  reason: string;
}

interface ResolvedVerdict {
  tier: TierKey;
  decidedBy: TierDecidedBy;
  reasons: string[];
}

/**
 * Raises beat lowers: if any raise fired, the highest raise (or the resting
 * tier, whichever is higher) wins and every lowering signal is dropped. A
 * lower applies only when nothing raised, and never below a CONFIGURED
 * resting tier (an owner prior or a source prior): no automatic signal lowers
 * what the owner or the source configured.
 */
function resolveVerdicts(
  resting: Verdict,
  raises: readonly Verdict[],
  lowers: readonly Verdict[],
  restingIsConfigured: boolean,
): ResolvedVerdict {
  const topRaise = raises.reduce<Verdict | undefined>(
    (best, verdict) => (best === undefined || tierRank(verdict.tier) > tierRank(best.tier) ? verdict : best),
    undefined,
  );
  if (topRaise && tierRank(topRaise.tier) > tierRank(resting.tier)) {
    const reasons = raises
      .filter((verdict) => verdict.tier === topRaise.tier)
      .map((verdict) => verdict.reason);
    return { tier: topRaise.tier, decidedBy: topRaise.decidedBy, reasons: [resting.reason, ...reasons] };
  }
  if (topRaise || restingIsConfigured || lowers.length === 0) {
    return { tier: resting.tier, decidedBy: resting.decidedBy, reasons: [resting.reason] };
  }
  // Nothing raised and the resting tier is the plain default: the most
  // sensitive lowering target wins (a Personal-target category beats a public
  // link, because raises-beat-lowers applies among lowers too).
  const chosen = lowers.reduce((best, verdict) => (tierRank(verdict.tier) > tierRank(best.tier) ? verdict : best));
  const reasons = lowers.filter((verdict) => verdict.tier === chosen.tier).map((verdict) => verdict.reason);
  return { tier: chosen.tier, decidedBy: chosen.decidedBy, reasons };
}

function maxVerdict(current: ResolvedVerdict, candidate: Verdict | ResolvedVerdict): ResolvedVerdict {
  if (tierRank(candidate.tier) > tierRank(current.tier)) {
    const added = 'reasons' in candidate ? candidate.reasons : [candidate.reason];
    return { tier: candidate.tier, decidedBy: candidate.decidedBy, reasons: [...current.reasons, ...added] };
  }
  return current;
}

function mostSensitive(rules: readonly OwnerTierRule[]): OwnerTierRule | undefined {
  return rules.reduce<OwnerTierRule | undefined>(
    (best, rule) => (best === undefined || tierRank(rule.tier) > tierRank(best.tier) ? rule : best),
    undefined,
  );
}

function ownerRuleMatches(
  rule: OwnerTierRule,
  signals: SourceClassificationSignals,
  provider: string | undefined,
): boolean {
  if (rule.source !== undefined && rule.source !== provider) return false;
  const value = rule.match.value.trim().toLowerCase();
  if (!value) return false;
  switch (rule.match.kind) {
    case 'pathPrefix':
      return (signals.path ?? '').trim().toLowerCase().startsWith(value);
    case 'folderKey':
    case 'chat':
      return (signals.folderKeys ?? []).some((key) => key.trim().toLowerCase() === value);
    case 'label':
      return (signals.labels ?? []).some((label) => label.trim().toLowerCase() === value);
    case 'sender':
      return (signals.sender ?? '').trim().toLowerCase().includes(value);
  }
}

/**
 * Detector signals reduced to content-free codes: `content:detector:financial:iban`,
 * `content:detector:health:vocabulary`. The engine's vocabulary signals name
 * the matched word; that word is dropped here.
 */
function detectorReasons(signals: readonly string[]): string[] {
  const codes = new Set<string>();
  for (const signal of signals) {
    const [family, kind] = signal.split(':');
    codes.add(`content:detector:${family}:${kind ?? 'signal'}`);
  }
  return [...codes].sort();
}

interface MapMatchInput {
  title?: string;
  sender?: string;
  path?: string;
}

function mapMatchInput(signals: SourceClassificationSignals): MapMatchInput {
  const title = signals.title?.trim();
  const sender = signals.sender?.trim();
  // A source without a folder path still has a name, and the name is the
  // path-shaped signal map path patterns are written against. Joined, never
  // chosen between, so a longer haystack can only add matches.
  const path = [signals.path?.trim(), title].filter((part): part is string => Boolean(part)).join('\n');
  return {
    ...(title ? { title } : {}),
    ...(sender ? { sender } : {}),
    ...(path ? { path } : {}),
  };
}

function namesOf(signals: SourceClassificationSignals): string {
  return [
    signals.title,
    signals.path,
    ...(signals.folderKeys ?? []),
    ...(signals.labels ?? []),
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n');
}
