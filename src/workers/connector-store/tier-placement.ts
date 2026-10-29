// Where the connector store puts an item, and how every item's four-tier
// decision gets recorded (design docs/design/per-item-four-tier-classification.md,
// phase P1a).
//
// SourceConnector 2.0.0 took the tier decision away from connectors: they now
// publish classification SIGNALS, and the shared tier classifier decides. In
// phase P1a that decision is RECORDED in the tier ledger and changes nothing
// about storage. Placement into the existing stores is declared per lane —
// the same resting tier and the same raises each store honoured before — so
// no item moves, no store is created and no vector is touched. Phase P1b
// switches placement to the recorded content tier through per-tier stores.
//
// Everything here is source-agnostic: a lane DECLARES its placement; nothing
// branches on which source an item came from.

import type { RawItem, SourceConnector } from '../../core/contracts.ts';
import {
  buildSourceSensitivity,
  type SourceSensitivity,
  type SourceTrustDomain,
  type SourceTrustTier,
} from '../../core/source-index/types.ts';
import { detectSecretFindingKinds } from '../classification/engine.ts';
import {
  TIER_CLASSIFIER_VERSION,
  classifyItemTiers,
  contentDigestReason,
  heldUntilJudged,
  type OwnerTierRule,
  type TierDecision,
  type TierSniffer,
} from '../classification/tier-classifier.ts';
import type { TierLedger, TierLedgerIdentity, TierLedgerRecord } from '../classification/tier-ledger.ts';
import { registeredInstalledTierClassification } from '../classification/installed-tier-classification-registry.ts';

/**
 * How a lane places items into the store(s) it has TODAY. This replaces the
 * placement half of the retired `SourceConnector.classify()`: each connector's
 * old fixed answer is now declared by the lane that owns the store.
 *
 * - `trustTier` / `trustDomain`: where an ordinary item rests. Defaults to the
 *   store's own domain at that domain's default tier. A lane whose items must
 *   only ever be Private (WhatsApp, Apple Messages, Dropbox) DECLARES
 *   secure_local rather than inheriting the store's domain, so wiring it to a
 *   less private store is refused item by item, fail closed.
 * - `secretsInContent`: an item whose textual body carries a secret finding
 *   is stored as S5, which the store tombstones (location only). This is the
 *   exact rule the file connector's classify() applied, on the same text.
 */
export interface ConnectorStorePlacementRule {
  trustTier?: SourceTrustTier;
  trustDomain?: SourceTrustDomain;
  secretsInContent?: boolean;
}

/**
 * A declared rule, or — for a lane whose existing store set needs a per-item
 * answer that no rule expresses — a store-owned function of the ITEM. The
 * function never sees the connector and never the tier decision; it is the
 * lane's own placement, kept only until phase P1b routes by the decision.
 */
export type ConnectorStorePlacement =
  | ConnectorStorePlacementRule
  | ((item: RawItem) => SourceSensitivity);

/**
 * Classifier configuration for recording tier decisions: the owner tier
 * rules (which the privacy profile writes) and the privacy-safe sniffer. A sync that brings none
 * uses the installed inputs (installed-tier-classification.ts), so every lane
 * records with the same ones.
 */
export interface ConnectorStoreTierClassification {
  rules?: readonly OwnerTierRule[];
  sniffer?: TierSniffer;
  /** This install has no Public tier: Public verdicts are lifted to Personal. */
  retirePublic?: boolean;
  /** The inputs cannot be trusted (an invalid rules file): record no decisions. */
  unavailableReason?: string;
  /**
   * The lane imports an archive: every item's content stays Private until
   * the privacy-safe model judges it (`TierClassificationInput.holdUntilJudged`;
   * docs/design/archive-import.md, "Privacy while an import is judged"). The
   * lane's own input, never an installed one; only an archive import lane
   * module may set it (test/tier-hold-until-judged-guard.test.ts).
   */
  holdContentUntilJudged?: true;
  /**
   * For a lane whose items can be children: the permitted context for judging
   * one, its parent's names, authorized and screened (parent-context.ts).
   * Supplied by the tiered store set, which can see the parent's stored names.
   */
  parentNamesContext?: (child: TierLedgerIdentity, parentLink?: string) => string | undefined;
}

/**
 * The classification inputs for one sync. With the installed inputs
 * configured (the worker), a lane's own inputs are merged into them: the
 * lane's rules (the mail scope's always-Private senders, WhatsApp's chat
 * rules) apply alongside the owner's rules file (re-read when edited, so
 * every lane sees an edit at its next pass), and the installed sniffer
 * answers unless the lane brought one. Unconfigured, the lane's inputs are
 * used as they are. Never throws.
 */
export function resolveStoreTierClassification(
  explicit: ConnectorStoreTierClassification | undefined,
  ledgerPath: string,
): ConnectorStoreTierClassification | undefined {
  const installed = registeredInstalledTierClassification()?.forLedger(ledgerPath);
  if (!installed) return explicit;
  if (!explicit) return installed;
  const rules = [...(explicit.rules ?? []), ...(installed.rules ?? [])];
  const sniffer = explicit.sniffer ?? installed.sniffer;
  const unavailableReason = installed.unavailableReason ?? explicit.unavailableReason;
  const retirePublic = installed.retirePublic === true || explicit.retirePublic === true;
  return {
    ...(rules.length > 0 ? { rules } : {}),
    ...(sniffer ? { sniffer } : {}),
    ...(retirePublic ? { retirePublic: true } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
    // The lane's own hold, carried as the lane set it (installed inputs have none).
    ...(explicit.holdContentUntilJudged === true ? { holdContentUntilJudged: true as const } : {}),
  };
}

const DEFAULT_TIER_FOR_DOMAIN: Readonly<Record<SourceTrustDomain, SourceTrustTier>> = {
  public_safe: 'S0',
  internal: 'S3',
  secure_local: 'S4',
};

export function defaultStoreTrustTier(trustDomain: SourceTrustDomain): SourceTrustTier {
  return DEFAULT_TIER_FOR_DOMAIN[trustDomain] ?? 'S4';
}

/** The lane's declared placement for one item. Pure, and never reads the tier decision. */
export function placeInExistingStore(
  item: RawItem,
  placement: ConnectorStorePlacement | undefined,
  storeTrustDomain: SourceTrustDomain,
): SourceSensitivity {
  if (typeof placement === 'function') return placement(item);
  const trustDomain = placement?.trustDomain ?? storeTrustDomain;
  const trustTier = placement?.trustTier ?? defaultStoreTrustTier(trustDomain);
  if (placement?.secretsInContent === true) {
    const text = textualContentOf(item);
    if (text !== undefined && detectSecretFindingKinds(text).length > 0) {
      return buildSourceSensitivity({ trustTier: 'S5', trustDomain: 'secure_local' });
    }
  }
  return buildSourceSensitivity({ trustTier, trustDomain });
}

/** A `(item) => SourceSensitivity` for store APIs that take one (restore, extraction sinks). */
export function existingStorePlacementClassifier(
  placement: ConnectorStorePlacement | undefined,
  storeTrustDomain: SourceTrustDomain,
): (item: RawItem) => SourceSensitivity {
  return (item) => placeInExistingStore(item, placement, storeTrustDomain);
}

/**
 * The item's body as text, when it has a textual one: text content, or bytes
 * whose MIME type is textual. Binary bodies are left to the extraction
 * factory, exactly as the retired file-connector classify() left them.
 */
export function textualContentOf(item: RawItem): string | undefined {
  if (item.content.kind === 'text') return item.content.text;
  if (item.content.kind === 'bytes' && isTextualMimeType(item.content.mimeType)) {
    return new TextDecoder('utf-8', { fatal: false }).decode(item.content.bytes);
  }
  return undefined;
}

function isTextualMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized === 'application/xml'
    || normalized.endsWith('+json')
    || normalized.endsWith('+xml');
}

/**
 * Run the shared tier classifier over one item: the connector's signals plus
 * the item's text. A per-item owner override is read from the ledger, where
 * overrides live.
 */
export function decideItemTiers(
  connector: Pick<SourceConnector, 'classificationSignals'>,
  item: RawItem,
  text: string | undefined,
  options: ConnectorStoreTierClassification | undefined,
  ledger: TierLedger | undefined,
  extra: { namesOnly?: boolean; contentFetchFailed?: boolean } = {},
): TierDecision {
  const read = ledger?.classificationRead(item.identity);
  const override = read?.override;
  // Only a listing that read the item's text is fresh enough to ask about an
  // item recorded Secrets (an unread one keeps the recorded content tier).
  // Blank text counts as unread, exactly as the classifier treats it.
  const fresh = text?.trim() ? extra.contentFetchFailed !== true : false;
  const recorded = ledger?.getCurrent(item.identity);
  const fenced = options?.sniffer && ledger && read
    ? secretFencedSniffer(options.sniffer, ledger, item.identity, read, { mayAskSecret: fresh })
    : options?.sniffer;
  const sniffer = fenced && recordedContentVerdictSniffer(fenced, recorded, text);
  // The lane's hold, the item's own (an item built from an archive record
  // carries it: contracts.ts, 2.2.0), or the one its stored decision carries
  // (a store whose recording did not bring the lane's option still holds the
  // same way, and a later version of a held item stays held until judged).
  const holdUntilJudged = options?.holdContentUntilJudged === true
    || item.holdContentUntilJudged === true
    || heldUntilJudged(recorded?.reasons);
  const parentContext = item.identity.parent
    ? options?.parentNamesContext?.(item.identity, item.identity.parent.localItemId)
    : undefined;
  return classifyItemTiers(
    {
      signals: connector.classificationSignals(item),
      locators: ['locatorUri', 'url', 'pathDisplay'].map(key => item.metadata[key])
        .filter((value): value is string => typeof value === 'string'),
      provider: item.identity.provider,
      ...(text !== undefined ? { text } : {}),
      ...(extra.namesOnly ? { namesOnly: true } : {}),
      ...(holdUntilJudged ? { holdUntilJudged: true } : {}),
      ...(parentContext ? { parentContext } : {}),
      mimeType: item.mimeType,
      subject: item.identity,
    },
    {
      ...(options?.rules ? { rules: options.rules } : {}),
      ...(sniffer ? { sniffer } : {}),
      ...(override ? { override } : {}),
      ...(options?.retirePublic ? { retirePublic: true } : {}),
    },
  );
}

/**
 * The sniffer for a listing of an item whose content question was already
 * answered for exactly these bytes, under this sniffer, classifier and map:
 * the recorded verdict answers again, and the item keeps it. The verdict
 * cache alone can miss it, since a re-judge asks with the names the stored
 * copy kept, which need not match the listing's; the unchanged item would
 * otherwise fall back to pending, and be asked again, on every listing.
 * Every other question goes to `sniffer`.
 */
export function recordedContentVerdictSniffer(
  sniffer: TierSniffer,
  recorded: TierLedgerRecord | undefined,
  text: string | undefined,
): TierSniffer {
  if (!recorded || !text?.trim() || recorded.state !== 'current' || recorded.contentPending || !recorded.contentRead) return sniffer;
  if (recorded.engineVersion !== TIER_CLASSIFIER_VERSION || !recorded.reasons.includes(contentDigestReason(text))) return sniffer;
  // The sniffer's verdict is the content tier, unless something else raised it: kept as recorded, never lower.
  const tier = recorded.contentTier;
  const prefix = `content:sniffer:${sniffer.id}:`;
  const code = recorded.reasons.find((reason) => reason.startsWith(prefix))?.slice(prefix.length);
  if ((tier !== 'private' && tier !== 'secure') || !code || code === 'undecided') return sniffer;
  return {
    id: sniffer.id,
    judge: (request) => request.pass === 'content' && (request.mapRevision ?? 'none') === recorded.mapRevision
      ? { verdict: 'decided', tier, code }
      : sniffer.judge(request),
  };
}

/**
 * The sniffer for one pass over one item, fenced against the item becoming
 * Secrets while the pass runs: a question is queued only if the item is not
 * Secrets in the ledger at that moment (read under the queue's lock), so the
 * names or excerpt the Secrets disposition just cleared are not queued
 * again. A listing that read the item Secrets already (`read`, the snapshot
 * it classifies with: `TierLedger.classificationRead`) is the fresh truth, its
 * secret gone, and may still ask, but only while the owner's override is the
 * one it read and no Secrets clearing ran since (the item's scrub revision):
 * a Secrets marking since then, by the owner or a detector, fences it. A
 * pass over a stored item (extraction, re-judge, migration) may ask only while
 * the item is not Secrets. Every pass passes the snapshot it took before
 * reading the item, and any Secrets clearing since then fences it.
 */
export function secretFencedSniffer(
  sniffer: TierSniffer,
  ledger: TierLedger,
  identity: TierLedgerIdentity,
  read: ReturnType<TierLedger['classificationRead']>,
  options: { mayAskSecret?: boolean } = {},
): TierSniffer {
  const stillAsk = (): boolean => {
    const now = ledger.classificationRead(identity);
    // Any clearing since the read fences the pass, whether or not a Secrets
    // decision was recorded (an extraction sink's untracked tombstone).
    if (now.scrubRevision !== read.scrubRevision) return false;
    if (!now.secret) return true;
    return options.mayAskSecret === true && read.secret
      && JSON.stringify(read.override ?? null) === JSON.stringify(now.override ?? null);
  };
  return { id: sniffer.id, judge: (request) => sniffer.judge({ ...request, stillAsk }) };
}
