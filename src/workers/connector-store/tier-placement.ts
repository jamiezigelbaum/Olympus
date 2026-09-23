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
import type { SensitivityMap } from '../../core/sensitivity-map.ts';
import {
  buildSourceSensitivity,
  type SourceSensitivity,
  type SourceTrustDomain,
  type SourceTrustTier,
} from '../../core/source-index/types.ts';
import { detectSecretFindingKinds } from '../classification/engine.ts';
import {
  classifyItemTiers,
  type OwnerTierRule,
  type TierDecision,
  type TierSniffer,
} from '../classification/tier-classifier.ts';
import type { TierLedger } from '../classification/tier-ledger.ts';

/**
 * How a lane places items into the store(s) it has TODAY. This replaces the
 * placement half of the retired `SourceConnector.classify()`: each connector's
 * old fixed answer is now declared by the lane that owns the store.
 *
 * - `trustTier` / `trustDomain`: where an ordinary item rests. Defaults to the
 *   store's own domain at that domain's default tier.
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
 * Classifier configuration for recording tier decisions. Owner rules and the
 * sniffer are P2 inputs; they are accepted now so tests can pin precedence.
 */
export interface ConnectorStoreTierClassification {
  sensitivityMap?: SensitivityMap;
  rules?: readonly OwnerTierRule[];
  sniffer?: TierSniffer;
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
): TierDecision {
  const override = ledger?.getOverride(item.identity);
  return classifyItemTiers(
    {
      signals: connector.classificationSignals(item),
      provider: item.identity.provider,
      ...(text !== undefined ? { text } : {}),
    },
    {
      ...(options?.sensitivityMap ? { sensitivityMap: options.sensitivityMap } : {}),
      ...(options?.rules ? { rules: options.rules } : {}),
      ...(options?.sniffer ? { sniffer: options.sniffer } : {}),
      ...(override ? { override } : {}),
    },
  );
}
