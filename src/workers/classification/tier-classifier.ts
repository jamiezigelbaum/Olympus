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
//   rule). Absence of sensitive signals is never enough.
// - The classifier reads SIGNAL KINDS only. It never branches on which source
//   an item came from; test/tier-classifier-source-agnostic.test.ts enforces it.
// - Reasons are content-free codes: finding kinds, fixed vocabulary families,
//   owner rule ids. Never a title, path, sender or text.
// - Deterministic. The privacy-safe sniffer is a seam (TierSniffer). The
//   shipped sniffer (sniffer.ts) answers synchronously from a verdict cache;
//   a miss answers "undecided", which leaves the tier where the deterministic
//   steps put it and marks the item pending until the background pass
//   (sniffer-resolver.ts) asks the privacy-safe model.

import { createHash } from 'node:crypto';
import type {
  SourceClassificationSignals,
  SourceClassificationTier,
} from '../../core/contracts.ts';
import {
  detectSecretFindingKinds,
  detectSensitiveContent,
} from './engine.ts';
import { ownerSenderRuleMatches } from '../../core/sender-rules.ts';
import { pathPrefixMatches } from '../../core/location-rules.ts';

export const TIER_CLASSIFIER_KIND = 'olympus_shared_four_tier_classifier';
// 2026-10-01.p2: vocabulary-only detector hits go to the privacy-safe model
// (borderline) instead of final-deciding Private, when a model can be asked.
// 2026-10-01.p3: when a model can be asked, EVERY item whose text was read is
// judged by it (with the item's names) before it may be Personal; a routed
// item decided under an older version is judged again (tier-rejudge.ts).
// 2026-10-02.p4: the card detector needs a card's shape (whole number, card
// grouping, issuer prefix and length, and for an unbroken run card words
// nearby or no numeric table around it), and the sniffer's injection screen
// needs the steering half of an instruction (comparison signs, "all lines"
// and "confidence" alone no longer count). Items decided under p3 are judged
// again, so a document either rule misfired on gets a real verdict.
// p5: Personal-first content; own-record signals hold only the content.
export const TIER_CLASSIFIER_VERSION = '2026-10-13.p5';

/**
 * The `mapRevision` every decision records. The legacy sensitivity map was
 * retired on 2026-10-03 (owner ruling: the privacy profile is the only
 * privacy path), so this is always `none`. The field stays because the tier
 * ledger and the sniffer verdict cache key on it; a fresh install never had
 * any other value.
 */
export const TIER_MAP_REVISION = 'none';

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
 * An owner folder / label / sender / chat rule (design section 2.4), loaded
 * from `~/.olympus/tier-rules.json` by tier-rules.ts.
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

/**
 * Opaque identity of the item a sniffer question is about. The classifier
 * never reads it; it is passed through so a sniffer that answers from a
 * verdict cache can queue the unanswered question for the background pass.
 */
export interface TierSnifferSubject {
  provider: string;
  accountScope: string;
  providerItemId: string;
  /** The conversation, for chat items: part of the ledger identity. */
  providerConversationId?: string;
}

/** Queue priority for an item held as someone's own record: ahead of ordinary background judgments. */
export const HELD_RECORD_PRIORITY = 10;

export interface TierSnifferRequest {
  pass: 'metadata' | 'content';
  /** Higher values run first (held records use HELD_RECORD_PRIORITY); aging still reserves progress for old questions. */
  priority?: number;
  /** Content-free reason the item was flagged, e.g. `names:health`. */
  flags: readonly string[];
  /**
   * What the privacy-safe model may read: the item's names (pass 1) or a short
   * excerpt of its text (pass 2). Never anything the secret detector caught:
   * the classifier does not ask the sniffer about an item it found a secret in.
   */
  material?: string;
  /** Digest of the full input, so an unchanged excerpt cannot reuse a changed document's verdict. */
  materialHash?: string;
  /** Always TIER_MAP_REVISION (a cache-key part kept from the retired sensitivity map). */
  mapRevision?: string;
  subject?: TierSnifferSubject;
}

/**
 * The privacy-safe model seam (design section 2.2, steps 7 and 12). A local or
 * Venice Private model answers here, through a verdict cache
 * (sniffer.ts). It may answer only Personal or Private, or `undecided`. It is
 * never asked about an item the secret detector caught, and never asked when
 * the deterministic tier is already Private.
 */
export type TierSnifferVerdict =
  | { verdict: 'undecided' }
  | { verdict: 'decided'; tier: 'private' | 'secure' | 'secrets'; code: string };

export interface TierSniffer {
  readonly id: string;
  judge(request: TierSnifferRequest): TierSnifferVerdict;
}

/** A sniffer that never decides, so flagged items stay pending (no private lane configured). */
export const UNDECIDED_TIER_SNIFFER: TierSniffer = Object.freeze({
  id: 'undecided',
  judge: (): TierSnifferVerdict => ({ verdict: 'undecided' }),
});

/** Longest names string handed to the sniffer (pass 1). */
export const SNIFFER_NAMES_MAX_CHARS = 400;
/** Longest text excerpt handed to the sniffer (pass 2): a short excerpt, never the document. */
export const SNIFFER_EXCERPT_MAX_CHARS = 1_200;
/**
 * The content-free flag of an excerpt question asked only because the text
 * was read (no name flag, no borderline family): every read item is judged
 * when a privacy-safe model can be asked.
 */
export const CONTENT_READ_SNIFFER_FLAG = 'content:read';
/** An open model question that does not hold the content (owner-approved). */
export const PERSONAL_FIRST_REASON = 'content:personal_first';

/** Persisted with the decision's content reasons, including while its question
 * waits. The store chunks trimmed text into contiguous slices; concatenating
 * those slices recovers precisely these bytes. No provider hash is trusted.
 * Keeping this receipt in the existing content reasons makes it travel through
 * queued moves, rejudges and late metadata updates without a schema migration. */
export function contentDigestReason(text: string): string {
  return `content:sha256:${createHash('sha256').update(text.trim()).digest('hex')}`;
}

/**
 * What the sniffer reads in pass 2: the item's names (title, folder path,
 * sender), when known, then the excerpt. The names are a signal of their own
 * (a records folder, a dated test title) that the text alone may not carry.
 */
export function snifferContentMaterial(names: string, excerpt: string): string {
  const trimmed = names.trim();
  return trimmed ? `Names: ${trimmed}\nExcerpt: ${excerpt}` : excerpt;
}

/** Cache/queue identity covers the complete input, not the bounded prompt.
 * Shared by listing, extraction and stored-item rejudges. */
export function tierSnifferInputHash(pass: 'metadata' | 'content', signals: SourceClassificationSignals, text?: string): string {
  return createHash('sha256').update(JSON.stringify([
    pass, signals.title ?? null, signals.path ?? null, signals.folderKeys ?? [],
    signals.labels ?? [], signals.sender ?? null, text ?? null,
  ])).digest('hex');
}

// --- Input / output -----------------------------------------------------------

export interface TierClassificationInput {
  signals: SourceClassificationSignals;
  /** Stored links are checked for credentials before any metadata is released; never model input. */
  locators?: readonly string[];
  /**
   * The item's provider, used ONLY to match owner rules that name a source.
   * Never compared against a literal in this module.
   */
  provider?: string;
  /** Full extracted text for pass 2. Absent means pass 2 has nothing to read. */
  text?: string;
  /**
   * The owner keeps this item's content unread (a names-only disposition):
   * its text never arrives, so pass 2 never runs (design 2.2: pass 2 is only
   * for items approved for full ingestion). The names decide both layers and
   * nothing waits on the text, so the item is never left pending forever.
   */
  namesOnly?: boolean;
  /**
   * The item's media type. A still image's content (its picture, and any
   * text read off it) rests Private unless the photo judge found the picture
   * ordinary (`imageJudgment`).
   */
  mimeType?: string;
  /** The photo judge's verdict on a still image's picture (media-judge.ts). Absent: unjudged. */
  imageJudgment?: ImageJudgmentSignal;
  /** Passed through to the sniffer only; never read here. */
  subject?: TierSnifferSubject;
}

/**
 * The photo judge's verdict on a still image's picture, as this classifier
 * reads it (the judge itself is source-index/media-judge.ts).
 */
export interface ImageJudgmentSignal {
  verdict: 'sensitive' | 'ordinary' | 'unjudged';
  category?: string;
}

/**
 * An UNJUDGED photo's content is Private, whatever text was read off it
 * (docs/design/photo-embeddings.md, owner decisions 2026-10-07 and
 * 2026-10-08): a picture no judge has looked at, or one that could not be
 * judged (no image encoder, off macOS, the judge failed), stays Private. The
 * names keep their own tier; only Secrets (a secret read in the picture's
 * text) and the owner's per-item override decide otherwise.
 */
export const IMAGE_PRIVATE_DEFAULT_REASON = 'content:image_private_default';
/** A photo the judge found sensitive is Private: `content:image_sensitive:<category>`. */
export const IMAGE_SENSITIVE_REASON_PREFIX = 'content:image_sensitive:';
/**
 * A photo the judge found ordinary is judged like any other file: its text
 * (OCR) through the usual rules, Personal by default. This reason marks that
 * the picture was judged.
 */
export const IMAGE_ORDINARY_REASON = 'content:image_ordinary';

/** Whether a media type is a still image, whose content rests Private unless its picture is judged ordinary. */
export function isImageMediaType(mimeType: string | undefined): boolean {
  return (mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '').startsWith('image/');
}

export interface TierClassificationOptions {
  rules?: readonly OwnerTierRule[];
  override?: ItemTierOverride;
  sniffer?: TierSniffer;
  /**
   * This install has no Public tier (a fresh install, owner ruling
   * 2026-10-01): anything that would be Public is Personal. Every other
   * step is unchanged; only the final Public verdict is lifted.
   */
  retirePublic?: boolean;
}

/** The reason code recorded when a Public verdict is lifted to Personal on an install without a Public tier. */
export const PUBLIC_RETIRED_REASON = 'tier:public_retired';

/** A decision with Public lifted to Personal (no Public tier on this install). Pure. */
export function withPublicRetired<T extends { metadataTier: TierKey; contentTier: TierKey; reasons: string[] }>(decision: T): T {
  if (decision.metadataTier !== 'public' && decision.contentTier !== 'public') return decision;
  return {
    ...decision,
    metadataTier: decision.metadataTier === 'public' ? 'private' : decision.metadataTier,
    contentTier: decision.contentTier === 'public' ? 'private' : decision.contentTier,
    reasons: [...decision.reasons, PUBLIC_RETIRED_REASON],
  };
}

export type TierDecisionState = 'pending' | 'current';

export interface TierDecision {
  metadataTier: TierKey;
  /**
   * The content tier. When `contentRead` is false this is only the floor the
   * metadata implies (content is at least the metadata tier), NOT a decision
   * about the text; the ledger never lets it replace or lower a content tier
   * that was decided from text.
   */
  contentTier: TierKey;
  /** Which step settled the content tier (the layer that governs the text). */
  decidedBy: TierDecidedBy;
  /** Content-free reason codes, metadata reasons first. */
  reasons: string[];
  /**
   * `pending` while any question is open: an unanswered sniffer question, or
   * content that has not been read yet.
   */
  state: TierDecisionState;
  /** Whether pass 2 read any text. An override counts as a content decision. */
  contentRead: boolean;
  /** A name-level sniffer question is unanswered. */
  metadataPending: boolean;
  /** The content tier is not final: unread, or an excerpt question is unanswered. */
  contentPending: boolean;
  /** A force rule or force prior fixed the tier; content may then rise only to Secrets. */
  metadataForced: boolean;
  /** Pass 1 flagged the names as possibly private (the content pass asks the sniffer too). */
  metadataFlagged: boolean;
  /**
   * The owner rule that set the names' resting (prior) or fixed (force) tier,
   * when one matched. A lane that never lets items rest below a floor unless
   * the OWNER said so reads this (tiered-store-set.ts, `laneFloor`). Absent
   * when no owner rule matched.
   */
  metadataOwnerRule?: TierOwnerRuleMatch;
  engineVersion: string;
  mapRevision: string;
  snifferId: string;
}

/** Which owner rule decided the names' tier: its match kind, tier and strength. No rule id, no value. */
export interface TierOwnerRuleMatch {
  kind: OwnerTierRule['match']['kind'];
  tier: TierKey;
  strength: OwnerTierRule['strength'];
}

export type TierDecidedBy =
  | 'override'
  | 'secret_detector'
  | 'owner_rule'
  | 'source_floor'
  | 'source_prior'
  | 'public_evidence'
  | 'sensitive_detector'
  | 'sniffer'
  | 'default';

// --- Classifier ----------------------------------------------------------------

export function classifyItemTiers(
  input: TierClassificationInput,
  options: TierClassificationOptions = {},
): TierDecision {
  const decision = classifyItemTiersWithPublic(input, options);
  if (input.text !== undefined && decision.contentTier !== 'secrets') decision.reasons.push(contentDigestReason(input.text));
  return options.retirePublic ? withPublicRetired(decision) : decision;
}

function classifyItemTiersWithPublic(
  input: TierClassificationInput,
  options: TierClassificationOptions,
): TierDecision {
  const signals = input.signals;
  const sniffer = options.sniffer ?? UNDECIDED_TIER_SNIFFER;
  const base = {
    engineVersion: TIER_CLASSIFIER_VERSION,
    mapRevision: TIER_MAP_REVISION,
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
      // The owner decided the content; nothing about the text can change it.
      contentRead: true,
      metadataPending: false,
      contentPending: false,
      metadataForced: true,
      metadataFlagged: false,
    };
  }
  const secretsCleared = options.override?.kind === 'not_secret';
  const clearedReason = secretsCleared ? ['override:item:not_secret'] : [];

  const names = namesOf(signals);
  const matchInput = namesMatchInput(signals);

  // ---------------------------------------------------------------- pass 1 --
  const metadata = metadataPass({
    signals,
    provider: input.provider,
    names,
    locators: input.locators ?? [],
    options,
    secretsCleared,
    sniffer,
    mapRevision: base.mapRevision,
    ...(input.subject ? { subject: input.subject } : {}),
  });

  // ---------------------------------------------------------------- pass 2 --
  const content = contentPass({
    signals,
    text,
    ...(input.namesOnly ? { namesOnly: true } : {}),
    ...(isImageMediaType(input.mimeType) ? { image: true } : {}),
    ...(input.imageJudgment ? { imageJudgment: input.imageJudgment } : {}),
    matchInput,
    names: snifferNames(signals),
    metadata,
    options,
    secretsCleared,
    sniffer,
    mapRevision: base.mapRevision,
    ...(input.subject ? { subject: input.subject } : {}),
  });

  const contentRead = text !== undefined || metadata.tier === 'secrets';
  // Unread text keeps the content decision open, unless the owner chose that
  // it is never read: then the names are the whole decision.
  const namesOnly = input.namesOnly === true && text === undefined;
  const contentPending = content.pending || (!contentRead && !namesOnly);
  return {
    ...base,
    metadataTier: metadata.tier,
    contentTier: content.tier,
    decidedBy: content.decidedBy,
    reasons: [...clearedReason, ...metadata.reasons, ...content.reasons],
    state: metadata.pending || contentPending ? 'pending' : 'current',
    contentRead,
    metadataPending: metadata.pending,
    contentPending,
    metadataForced: metadata.forced,
    metadataFlagged: metadata.flags.length > 0,
    ...(metadata.ownerRule ? { metadataOwnerRule: metadata.ownerRule } : {}),
  };
}

/**
 * Pass 2 alone, for a lane whose text arrives after the item was listed (the
 * shared extraction factory). It starts from the metadata decision already
 * recorded in the ledger and can only raise it. Names are not available here,
 * so the detectors read the text alone; the listing-time decision already
 * covered the names.
 */
export interface ContentTierInput {
  text: string;
  metadataTier: TierKey;
  metadataForced: boolean;
  metadataFlagged: boolean;
  /**
   * An owner rule settled the names' tier: the text is then not sent to the
   * sniffer just because it was read (`namesDecidedByOwner`).
   */
  metadataOwnerDecided?: boolean;
  /**
   * The item's names, when the caller has them: they travel with the text so
   * a detector's origin hint and a title's vocabulary still count, exactly
   * as they do when the text arrives with the listing.
   */
  title?: string;
  path?: string;
  sender?: string;
  /** The item's media type: a still image's content rests Private unless judged ordinary. */
  mimeType?: string;
  /** The photo judge's verdict on a still image's picture. Absent: unjudged. */
  imageJudgment?: ImageJudgmentSignal;
  /** Passed through to the sniffer only; never read here. */
  subject?: TierSnifferSubject;
}

export interface ContentTierDecision {
  contentTier: TierKey;
  decidedBy: TierDecidedBy;
  reasons: string[];
  contentPending: boolean;
  engineVersion: string;
  mapRevision: string;
  snifferId: string;
}

export function classifyContentTier(
  input: ContentTierInput,
  options: Omit<TierClassificationOptions, 'rules'> = {},
): ContentTierDecision {
  const sniffer = options.sniffer ?? UNDECIDED_TIER_SNIFFER;
  const base = {
    engineVersion: TIER_CLASSIFIER_VERSION,
    mapRevision: TIER_MAP_REVISION,
    snifferId: sniffer.id,
  };
  if (options.override?.kind === 'tier') {
    const tier = options.retirePublic && options.override.tier === 'public' ? 'private' : options.override.tier;
    return {
      ...base,
      contentTier: tier,
      decidedBy: 'override',
      reasons: [`override:item:${options.override.tier}`, ...(tier !== options.override.tier ? [PUBLIC_RETIRED_REASON] : []), contentDigestReason(input.text)],
      contentPending: false,
    };
  }
  const text = input.text.trim() ? input.text : undefined;
  const content = contentPass({
    signals: {
      ...(input.title ? { title: input.title } : {}),
      ...(input.path ? { path: input.path } : {}),
      ...(input.sender ? { sender: input.sender } : {}),
    },
    text,
    ...(isImageMediaType(input.mimeType) ? { image: true } : {}),
    ...(input.imageJudgment ? { imageJudgment: input.imageJudgment } : {}),
    matchInput: namesMatchInput({
      ...(input.title?.trim() ? { title: input.title } : {}),
      ...(input.path?.trim() ? { path: input.path } : {}),
      ...(input.sender?.trim() ? { sender: input.sender } : {}),
    }),
    names: snifferNames({
      ...(input.title?.trim() ? { title: input.title } : {}),
      ...(input.path?.trim() ? { path: input.path } : {}),
      ...(input.sender?.trim() ? { sender: input.sender } : {}),
    }),
    metadata: {
      tier: input.metadataTier,
      decidedBy: 'default',
      reasons: [],
      pending: false,
      forced: input.metadataForced,
      flags: input.metadataFlagged ? ['names:recorded'] : [],
      ...(input.metadataOwnerDecided ? { ownerDecided: true } : {}),
    },
    options,
    secretsCleared: options.override?.kind === 'not_secret',
    sniffer,
    mapRevision: base.mapRevision,
    ...(input.subject ? { subject: input.subject } : {}),
  });
  const lifted = options.retirePublic === true && content.tier === 'public';
  return {
    ...base,
    contentTier: lifted ? 'private' : content.tier,
    decidedBy: content.decidedBy,
    reasons: [...content.reasons, ...(lifted ? [PUBLIC_RETIRED_REASON] : []),
      ...(content.tier !== 'secrets' ? [contentDigestReason(input.text)] : [])],
    contentPending: content.pending || text === undefined,
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
  /** The owner rule that set (prior) or fixed (force) the tier, if any. */
  ownerRule?: TierOwnerRuleMatch;
  /** An owner rule settled the names' tier (no read-only sniffer question). */
  ownerDecided?: boolean;
}

/**
 * Whether recorded reasons show an OWNER RULE settled the names' tier (a
 * prior rule; a force rule is `metadataForced`). Such an item is not sent to
 * the sniffer only because its text was read: the owner already said where
 * it belongs.
 */
export function namesDecidedByOwner(reasons: readonly string[]): boolean {
  return reasons.some((reason) => reason.startsWith('metadata:owner_rule:'));
}

function metadataPass(args: {
  signals: SourceClassificationSignals;
  provider: string | undefined;
  names: string;
  locators: readonly string[];
  options: TierClassificationOptions;
  secretsCleared: boolean;
  sniffer: TierSniffer;
  mapRevision: string;
  subject?: TierSnifferSubject;
}): PassResult {
  const { signals, names, options } = args;

  // [2] Secret detector on title + path. Nothing but an override outranks it.
  if (!args.secretsCleared) {
    const fields = [signals.title, signals.path, signals.sender, ...(signals.labels ?? []), ...(signals.folderKeys ?? []), ...args.locators]
      .filter((value): value is string => typeof value === 'string');
    const secretKinds = detectSecretFindingKinds(fields.join('\n'));
    // Names are releasable data too. URL userinfo and encoded credential
    // parameters must never reach the metadata model or a names-only copy.
    if (fields.some(hasCredentialUrl) && !secretKinds.includes('credential_assignment')) secretKinds.push('credential_assignment');
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
  // A provider floor is a fact, not a preference: it applies AFTER a force
  // rule or force prior, so neither can lower an item below it (a Telegram
  // Secret Chat stays Private under a force-Public rule).
  const floorReason = signals.floor ? `metadata:floor:${slug(signals.floor.basis)}` : undefined;
  const forced = (tier: TierKey, decidedBy: TierDecidedBy, reason: string, ownerRule?: TierOwnerRuleMatch): PassResult => {
    const floor = signals.floor;
    const flooredTier = floor && tierRank(floor.tier) > tierRank(tier) ? floor.tier : tier;
    return {
      tier: flooredTier,
      decidedBy: flooredTier === tier ? decidedBy : 'source_floor',
      reasons: flooredTier === tier ? [reason] : [reason, floorReason!],
      pending: false,
      forced: true,
      flags: [],
      ...(ownerRule ? { ownerRule } : {}),
    };
  };
  const forceRule = mostSensitive(matchedRules.filter((rule) => rule.strength === 'force'));
  if (forceRule) {
    return forced(
      forceRule.tier,
      'owner_rule',
      `metadata:owner_rule:${forceRule.match.kind}:${slug(forceRule.id)}:force`,
      { kind: forceRule.match.kind, tier: forceRule.tier, strength: 'force' },
    );
  }
  const priorRule = mostSensitive(matchedRules.filter((rule) => rule.strength === 'prior'));

  // A source-level force prior behaves like a force rule.
  if (signals.prior?.strength === 'force' && !priorRule) {
    return forced(
      signals.prior.tier === 'secrets' ? 'secure' : signals.prior.tier,
      'source_prior',
      `metadata:prior:${slug(signals.prior.basis)}:force`,
    );
  }

  if (priorRule) {
    resting = { tier: priorRule.tier, decidedBy: 'owner_rule', reason: `metadata:owner_rule:${priorRule.match.kind}:${slug(priorRule.id)}:prior` };
    restingIsConfigured = true;
  } else if (signals.prior) {
    resting = { tier: signals.prior.tier, decidedBy: 'source_prior', reason: `metadata:prior:${slug(signals.prior.basis)}` };
    restingIsConfigured = true;
  }
  // A configured Secrets resting tier is honoured as Private for the NAMES:
  // Secrets are location-only and a prior is not a secret finding.
  if (resting.tier === 'secrets') resting = { ...resting, tier: 'secure' };

  // [4] Source floor (a provider fact): always a raise.
  if (signals.floor) {
    raises.push({ tier: signals.floor.tier, decidedBy: 'source_floor', reason: floorReason! });
  }

  // [5] Retired: the legacy sensitivity map (2026-10-03). Owner folder,
  // label and sender rules (step [3], the privacy profile) replace it.

  // [6] Deterministic public evidence.
  if (signals.sharing === 'public_link' || signals.sharing === 'published') {
    lowers.push({ tier: 'public', decidedBy: 'public_evidence', reason: `metadata:evidence:${signals.sharing}` });
  }

  let decided = resolveVerdicts(resting, raises, lowers, restingIsConfigured);

  // [7] Sniffer, only when names look possibly private and nothing already
  // made them Private.
  // Topic words are not evidence that the names themselves are private.
  // Structured values in names still require their own metadata judgment.
  const flags = detectSensitiveContent({ text: names }).signals.map((signal) => `names:${signal}`);
  let pending = false;
  if (flags.length > 0 && tierRank(decided.tier) < tierRank('secure')) {
    const verdict = args.sniffer.judge({
      pass: 'metadata',
      priority: HELD_RECORD_PRIORITY,
      flags,
      material: snifferNames(signals),
      materialHash: tierSnifferInputHash('metadata', signals),
      mapRevision: args.mapRevision,
      ...(args.subject ? { subject: args.subject } : {}),
    });
    if (verdict.verdict === 'decided') {
      decided = withSnifferVerdict(decided, verdict.tier, `metadata:sniffer:${args.sniffer.id}:${verdict.code}`);
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
  return {
    tier: decided.tier,
    decidedBy: decided.decidedBy,
    reasons,
    pending,
    forced: false,
    flags,
    ...(priorRule ? { ownerDecided: true } : {}),
    ...(priorRule ? { ownerRule: { kind: priorRule.match.kind, tier: priorRule.tier, strength: 'prior' as const } } : {}),
  };
}

function contentPass(args: {
  signals: SourceClassificationSignals;
  text: string | undefined;
  /** The owner keeps the content unread (TierClassificationInput.namesOnly). */
  namesOnly?: boolean;
  /** The item is a still image: its content rests Private unless its picture was judged ordinary. */
  image?: boolean;
  imageJudgment?: ImageJudgmentSignal;
  matchInput: NamesMatchInput;
  /** The item's names (title, folder path, sender), bounded: they travel with the excerpt. */
  names: string;
  metadata: PassResult;
  options: TierClassificationOptions;
  secretsCleared: boolean;
  sniffer: TierSniffer;
  mapRevision: string;
  subject?: TierSnifferSubject;
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
      reasons: [args.namesOnly ? 'content:names_only' : 'content:unread'],
      // Names only: the content IS the names' tier, and a names verdict
      // settles both; nothing is left open on the text.
      pending: args.namesOnly ? false : metadata.pending,
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

  // A still image's content is Private unless the photo judge found its
  // picture ordinary: an unjudged picture, and a sensitive one, rest Private
  // whatever their text says and whatever rule set the names (only Secrets,
  // above, and the per-item override, before either pass, decide otherwise).
  // An ordinary picture's text goes through the usual rules below, so an
  // account or card number read off it still makes it Private.
  const imageOrdinary = args.image === true && args.imageJudgment?.verdict === 'ordinary';
  if (args.image && args.imageJudgment?.verdict === 'sensitive') {
    return {
      tier: maxTier(metadata.tier, 'secure'),
      decidedBy: 'default',
      reasons: [`${IMAGE_SENSITIVE_REASON_PREFIX}${imageCategoryCode(args.imageJudgment.category)}`],
      pending: false,
    };
  }
  if (args.image && !imageOrdinary) {
    return { tier: maxTier(metadata.tier, 'secure'), decidedBy: 'default', reasons: [IMAGE_PRIVATE_DEFAULT_REASON], pending: false };
  }

  // A force rule fixes the tier; only Secrets (above) may still raise it.
  if (metadata.forced) {
    return { tier: metadata.tier, decidedBy: metadata.decidedBy, reasons: [], pending: false };
  }

  let decided: ResolvedVerdict = { tier: metadata.tier, decidedBy: metadata.decidedBy, reasons: [] };

  // [10] Structured identifiers raise at once. Topic vocabulary only
  // selects useful passages for the model; it never holds or raises.
  const detection = detectSensitiveContent({
    text,
    ...(args.matchInput.title ? { title: args.matchInput.title } : {}),
    ...(args.matchInput.sender ? { sender: args.matchInput.sender } : {}),
    ...(args.matchInput.path ? { path: args.matchInput.path } : {}),
  });
  const canAskSniffer = args.sniffer.id !== UNDECIDED_TIER_SNIFFER.id;
  if (detection.signals.length > 0) {
    decided = maxVerdict(decided, {
      tier: 'secure',
      decidedBy: 'sensitive_detector',
      reasons: detectorReasons(detection.signals),
    });
  }

  // [11] Retired with the legacy sensitivity map (2026-10-03).

  // [12] Every eligible read item still gets its own background judgment.
  // Only own-record signals hold its content while that answer is missing.
  const recordFlags = ownRecordSignals(text, args.matchInput);
  let pending = false;
  const flags = [
    ...metadata.flags,
    ...recordFlags.map(signal => `content:own_record:${signal}`),
    ...(canAskSniffer ? detection.borderline.map((family) => `content:borderline:${family}`) : []),
  ];
  if (canAskSniffer && flags.length === 0 && metadata.ownerDecided !== true) flags.push(CONTENT_READ_SNIFFER_FLAG);
  const reasons = [...decided.reasons];
  if (flags.length > 0 && tierRank(decided.tier) < tierRank('secure')) {
    const verdict = args.sniffer.judge({
      pass: 'content',
      priority: recordFlags.length > 0 || metadata.pending ? HELD_RECORD_PRIORITY : 0,
      flags,
      material: snifferContentMaterial(args.names, snifferExcerpt(text, vocabularyTerms(detection.vocabulary))),
      materialHash: tierSnifferInputHash('content', args.signals, text),
      mapRevision: args.mapRevision,
      ...(args.subject ? { subject: args.subject } : {}),
    });
    if (verdict.verdict === 'decided') {
      decided = withSnifferVerdict(decided, verdict.tier, `content:sniffer:${args.sniffer.id}:${verdict.code}`);
      reasons.splice(0, reasons.length, ...decided.reasons);
    } else {
      pending = true;
      if (recordFlags.length === 0 && !metadata.pending) reasons.push(PERSONAL_FIRST_REASON);
      for (const flag of recordFlags) reasons.push(`content:own_record:${flag}`);
      for (const flag of detection.borderline) reasons.push(`content:borderline:${flag}`);
      reasons.push(`content:sniffer:${args.sniffer.id}:undecided`);
    }
  }
  if (reasons.length === 0) reasons.push('content:no_raise');
  if (imageOrdinary) reasons.unshift(IMAGE_ORDINARY_REASON);
  return { tier: decided.tier, decidedBy: decided.decidedBy, reasons: [...new Set(reasons)], pending };
}

/** Shared with placement so a credential URL is not retained as a Secret location. */
export function hasCredentialUrl(material: string): boolean {
  // Try a whole locator first: valid URL userinfo may contain spaces or
  // apostrophes. In prose, retain quotes rather than truncating a password.
  const candidates = [material.trim(), ...Array.from(material.matchAll(/https?:\/\/[^\s<>]+/gi), match => match[0])];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.username || url.password) return true;
      for (const [key, value] of url.searchParams) {
        if (value && /^(?:access_token|refresh_token|api_key|client_secret|password)$/i.test(key)) return true;
      }
    } catch { /* Not a URL; the regular credential detector still applies. */ }
  }
  return false;
}

/** Source-neutral evidence of a populated record, never a topic classifier. */
function ownRecordSignals(text: string, names: NamesMatchInput): string[] {
  const signals: string[] = [];
  const value = String.raw`[+-]?\d+(?:[.,]\d+)?`;
  const unit = String.raw`(?:mg\s*/\s*d[lL]|mmol\s*/\s*[lL]|g\s*/\s*d[lL]|mIU\s*/\s*[lL]|[uµμ]g\s*/\s*[lL]|ng\s*/\s*m[lL]|mmHg|bpm|kg|cm|°[CF])`;
  if (new RegExp(String.raw`\b${value}\s*${unit}(?![\p{L}])`, 'iu').test(text)
    || new RegExp(String.raw`\b${value}[^\n]{0,60}(?:reference\s+(?:range|interval)|normal\s+range)\s*[:(]?\s*${value}\s*[-–—]\s*${value}`, 'iu').test(text)) {
    signals.push('measurement');
  }
  if (/\b(?:patient|account\s+holder|applicant)(?:\s+name)?\s*[:=]\s*[\p{L}][\p{L}'’.-]+(?:[ \t]+[\p{L}][\p{L}'’.-]+)*/iu.test(text)) signals.push('named_holder');
  // At least two populated, distinct form fields; blank templates do not count.
  const fields = [...text.matchAll(/(?:^|\n)\s*(name|full name|first name|last name|date of birth|dob|email|phone|address|signature|occupation|marital status)\s*[:=]\s*([^\n]+)/giu)]
    .filter(match => /[\p{L}\p{N}]/u.test(match[2]!) && !/^(?:_{2,}|\[|<|enter\b|your\b|n\/a\b)/i.test(match[2]!.trim()));
  if (new Set(fields.map(match => match[1]!.toLowerCase())).size >= 2) signals.push('filled_form');
  // A folder segment, not a filename or a mention of a folder in prose.
  if (/(?:^|[/\\])(?:labs?|medical|taxes|statements|legal)(?:[/\\])/i.test(names.path ?? '')) signals.push('records_folder');
  const title = names.title ?? '';
  if (/\b(?:test|lab|bloodwork|blood work|visit|statement|results?)\b/i.test(title)
    && /\b(?:\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:\d{4}|\d{1,2}(?:,?\s+\d{4})?))\b/i.test(title)) signals.push('dated_record');
  return signals;
}

/** A category code safe in a reason string (the judge's own codes pass unchanged). */
function imageCategoryCode(category: string | undefined): string {
  const allowed = 'abcdefghijklmnopqrstuvwxyz0123456789_';
  const code = [...(category ?? '').toLowerCase()].filter((char) => allowed.includes(char)).join('');
  return code || 'unspecified';
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

/**
 * Apply a sniffer verdict. It can only raise (the sniffer answers Personal or
 * Private, and the tier it is asked about is at least Personal), but its
 * reason is recorded either way so `olympus tier explain` shows the question
 * was answered.
 */
function withSnifferVerdict(current: ResolvedVerdict, tier: TierKey, reason: string): ResolvedVerdict {
  if (tierRank(tier) > tierRank(current.tier)) {
    return { tier, decidedBy: 'sniffer', reasons: [...current.reasons, reason] };
  }
  return { ...current, reasons: [...current.reasons, reason] };
}

function mostSensitive(rules: readonly OwnerTierRule[]): OwnerTierRule | undefined {
  return rules.reduce<OwnerTierRule | undefined>(
    (best, rule) => (best === undefined || tierRank(rule.tier) > tierRank(best.tier) ? rule : best),
    undefined,
  );
}

/**
 * Whether an owner rule applies to an item's signals. Exported so a lane's
 * store placement honours exactly the rules the recorded decision does.
 */
export function ownerRuleMatches(
  rule: OwnerTierRule,
  signals: SourceClassificationSignals,
  provider: string | undefined,
): boolean {
  if (rule.source !== undefined && rule.source !== provider) return false;
  const value = rule.match.value.trim().toLowerCase();
  if (!value) return false;
  switch (rule.match.kind) {
    case 'pathPrefix':
      return pathPrefixMatches(signals.path, value);
    case 'folderKey':
    case 'chat':
      return (signals.folderKeys ?? []).some((key) => key.trim().toLowerCase() === value);
    case 'label':
      return (signals.labels ?? []).some((label) => label.trim().toLowerCase() === value);
    case 'sender':
      // The one sender matcher (core/sender-rules.ts): addresses and @domain
      // rules on the sender's own address with a label boundary; a bare
      // fragment by substring only when the rule raises the tier.
      return ownerSenderRuleMatches(signals.sender, value, tierRank(rule.tier) > tierRank('private'));
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

interface NamesMatchInput {
  title?: string;
  sender?: string;
  path?: string;
}

function namesMatchInput(signals: SourceClassificationSignals): NamesMatchInput {
  const title = signals.title?.trim();
  const sender = signals.sender?.trim();
  // Keep the path separate: records-folder signals apply to directory
  // segments, not to words in a title.
  const path = signals.path?.trim();
  return {
    ...(title ? { title } : {}),
    ...(sender ? { sender } : {}),
    ...(path ? { path } : {}),
  };
}

/** The names the sniffer may read (pass 1, and with the excerpt in pass 2), bounded. The sender is metadata too. */
function snifferNames(signals: SourceClassificationSignals): string {
  const joined = [
    signals.title,
    signals.path,
    ...(signals.folderKeys ?? []),
    ...(signals.labels ?? []),
    signals.sender,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join(' | ');
  return joined.slice(0, SNIFFER_NAMES_MAX_CHARS);
}

/** How much of the document's opening a focused excerpt keeps before the matched passages. */
const SNIFFER_EXCERPT_HEAD_CHARS = 600;
/** Most matched passages a focused excerpt carries. */
const SNIFFER_EXCERPT_MAX_FOCUS = 2;
const SNIFFER_EXCERPT_GAP = ' … ';

/**
 * A short excerpt of the text for pass 2, bounded by SNIFFER_EXCERPT_MAX_CHARS.
 * Without focus terms it is the start of the document. With them (the words a
 * vocabulary detector matched), it is the opening plus a short passage around
 * the first match of each term past the opening, so the model reads what the
 * detector saw. Still an excerpt, never the document.
 */
function snifferExcerpt(text: string, focusTerms: readonly string[] = []): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (focusTerms.length === 0 || flat.length <= SNIFFER_EXCERPT_MAX_CHARS) {
    return flat.slice(0, SNIFFER_EXCERPT_MAX_CHARS);
  }
  const head = flat.slice(0, SNIFFER_EXCERPT_HEAD_CHARS);
  const positions: number[] = [];
  for (const term of focusTerms) {
    const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const found = pattern.exec(flat.slice(head.length));
    if (found) positions.push(head.length + found.index);
  }
  const focus = [...new Set(positions)].sort((a, b) => a - b).slice(0, SNIFFER_EXCERPT_MAX_FOCUS);
  if (focus.length === 0) return flat.slice(0, SNIFFER_EXCERPT_MAX_CHARS);
  const window = Math.floor(
    (SNIFFER_EXCERPT_MAX_CHARS - head.length - SNIFFER_EXCERPT_GAP.length * focus.length) / focus.length,
  );
  const parts = [head];
  let cursor = head.length;
  for (const position of focus) {
    const start = Math.max(cursor, position - Math.floor(window / 2));
    const end = Math.min(flat.length, start + window);
    if (end <= start) continue;
    parts.push(flat.slice(start, end));
    cursor = end;
  }
  return parts.join(SNIFFER_EXCERPT_GAP).slice(0, SNIFFER_EXCERPT_MAX_CHARS);
}

/** The matched words of vocabulary signals (`health:vocabulary:treatment` → `treatment`). */
function vocabularyTerms(signals: readonly string[]): string[] {
  return signals
    .filter((signal) => signal.split(':')[1] === 'vocabulary')
    .map((signal) => signal.split(':').slice(2).join(':'))
    .filter((term) => term.length > 0);
}

function namesOf(signals: SourceClassificationSignals): string {
  return [
    signals.title,
    signals.path,
    ...(signals.folderKeys ?? []),
    ...(signals.labels ?? []),
    signals.sender,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n');
}

const SLUG = /^[a-z0-9][a-z0-9_.:-]{0,95}$/i;

/**
 * Basis codes and rule ids are configuration, and they end up inside reason
 * codes. Anything that is not a short slug (a path, a name, free text) is
 * refused into the reason as `invalid` rather than copied.
 */
function slug(value: string): string {
  return SLUG.test(value) ? value : 'invalid';
}
