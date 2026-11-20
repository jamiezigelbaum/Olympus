import type { SourceItemIdentity } from '../../core/source-index/types.ts';
import { OperationError } from '../../core/operation-error.ts';
import {
  classifyItemTiers, contentDigestReason, contentSecretFindingKinds, HELD_UNTIL_JUDGED_REASON, isImageMediaType,
  LEGACY_PERSONAL_BODY_REASON, maxTier, ownerOverrideSecretReview, personalContentAuthorized, TIER_CLASSIFIER_VERSION, TIER_MAP_REVISION,
  type ItemTierOverride, type ImageJudgmentSignal, type TierDecision, type TierKey,
} from '../classification/tier-classifier.ts';
import { detectSecretFindingKinds } from '../classification/engine.ts';
import type { TierLedger, TierLedgerRecord } from '../classification/tier-ledger.ts';
import type { TierSnifferStore } from '../classification/sniffer-store.ts';
import { imageJudgmentSignal } from '../source-index/media-judge.ts';
import type { LocalConnectorStore } from './local-index.ts';
import { settleSecretsCopies } from './secrets-disposition.ts';
import { storedSignals } from './stored-names.ts';
import { moveRestoredItemToHold, TIER_MOVE_CONNECTOR_ID } from './tier-move.ts';
import { recordSecretLocation, settleRoutedSecrets } from './tier-rejudge.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

/** Put-back owns the stopped stores. A live pass hides the copy and leaves the transfer to the mover. */
export function placePersonalBody(set: TieredStoreSet, personal: LocalConnectorStore,
  item: { identity: SourceItemIdentity; mimeType?: string; text: string },
  queue: TierSnifferStore | undefined, mode: 'restore' | 'walk',
  walk?: { previousLedger?: TierLedger; movesAvailable: boolean }): 'unchanged' | 'held' | 'secrets' | 'retry' | 'waiting' {
  const { ledger } = set;
  const { identity, text } = item;
  if (mode === 'restore' && !text.trim()) return 'unchanged';
  const current = ledger.getCurrent(identity);
  const previousLedger = walk?.previousLedger;
  const movesAvailable = walk?.movesAvailable ?? true;
  const previous = previousLedger?.getCurrent(identity);
  // Stored text cannot supply the original digest of a legacy override.
  const readOverride = (source: TierLedger) => movesAvailable ? source.observeOverrideText(identity) : source.getOverride(identity);
  const override = readOverride(ledger);
  const effectiveOverride = override ?? (!current?.routed && previousLedger ? readOverride(previousLedger) : undefined);
  const copies = ledger.copies(identity);
  const copy = copies.find(copy => copy.corpusId === personal.corpusId && (mode === 'walk' || copy.layers !== 'metadata'));
  if (effectiveOverride?.kind !== 'not_secret' && (effectiveOverride?.tier === 'secrets'
    || [current, current?.routed ? undefined : previous].some(record => record && [record.metadataTier, record.contentTier, record.targetMetadataTier,
      record.targetContentTier].includes('secrets')))) {
    if (!movesAvailable) return 'waiting';
    const record = set.adoptLegacyItem(identity)!;
    const { copies: hidden } = ledger.flipToSecrets(identity, {
      expectedGeneration: record.generation, ...(mode === 'walk' ? { guard: { generation: record.generation, override } } : {}),
    });
    const locations = mode === 'walk' ? set.secrets() : undefined;
    if (locations && !locations.get(identity)) {
      const names = personal.exportItemNames(identity);
      if (names) recordSecretLocation(locations, { metadataTier: 'secrets' }, names, { text, findingKinds: detectSecretFindingKinds(text) });
    }
    if (!hidden.some(copy => copy.corpusId === personal.corpusId)) {
      personal.tombstoneCopy(identity, { trustTier: 'S5', connectorId: TIER_MOVE_CONNECTOR_ID });
      personal.durabilityBarrier();
    }
    settleSecretsCopies({
      ledger, identity, copies: hidden, connectorId: TIER_MOVE_CONNECTOR_ID, ...(mode === 'restore' ? { restoreQueue: true } : {}),
      storeFor: corpusId => {
        const domain = set.domainForCorpus(corpusId);
        return domain && set.store(domain);
      },
    });
    return 'secrets';
  }
  const resuming = mode === 'restore' && current?.state === 'moving' && copy?.state === 'superseded'
    && copy.supersededByGeneration === current.generation + 1
    && ((current.reasons.includes(HELD_UNTIL_JUDGED_REASON) && current.contentPending) || !!ownerOverrideSecretReview(current.reasons));
  if (current?.routed && !resuming && copy?.state !== 'current') return 'unchanged';
  const ownerTier = effectiveOverride?.kind === 'tier' ? effectiveOverride.tier : undefined;
  const photo = isImageMediaType(item.mimeType) ? personal.imageJudgmentForItem(identity) : undefined;
  const image = photo && imageJudgmentSignal(photo);
  const currentAllowsPersonal = !current || (current.state !== 'moving' && !current.metadataPending
    && (current.contentTier === 'private' || current.contentTier === 'public')
    && (current.metadataTier === 'private' || current.metadataTier === 'public'));
  if (currentAllowsPersonal && ownerTier !== 'secure'
    && [current, previous].some(record => record && exactPersonalReceipt(record, text, effectiveOverride, image))) return 'unchanged';
  if (!movesAvailable) return 'waiting';
  // Put-back rejects a conflict before replacing the old question. A live
  // Secret disposition also needs to know that no other version would be
  // lost. The ordinary live move checks all copies under its writer locks.
  const conflict = () => ledger.copies(identity).some(other => {
    if (other.corpusId === personal.corpusId || other.state !== 'current'
      || (mode === 'restore' && (other.trustDomain !== 'secure_local' || other.layers === 'metadata'))) return false;
    const otherText = set.store(other.trustDomain)?.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('');
    return !!otherText && otherText !== text;
  });
  let record: TierLedgerRecord | undefined;
  if (mode === 'restore') {
    record = set.adoptLegacyItem(identity);
    if (conflict()) throw new OperationError('config_error', 'The restored tier stores contain different active bodies for the same item.');
    queue?.deleteItemQuestions(identity);
  }
  const needsNames = mode === 'walk' || ownerTier === 'private' || ownerTier === 'public';
  const names = needsNames ? personal.exportItemNames(identity) : undefined;
  const scanned = names ? classifyItemTiers({ signals: storedSignals(names), text }, effectiveOverride ? { override: effectiveOverride } : {}) : undefined;
  if (mode === 'walk' && !names) return 'retry';
  record ??= set.adoptLegacyItem(identity)!;
  if (mode === 'walk' && names && scanned?.contentTier === 'secrets' && !conflict()) {
    const settled = settleRoutedSecrets(set, identity, { ...scanned, metadataTier: maxTier(record.metadataTier, scanned.metadataTier) }, names, {
      text, findingKinds: contentSecretFindingKinds(scanned.reasons),
    }, { guard: { generation: record.generation, override } });
    return settled ? 'secrets' : 'retry';
  }
  // A question about earlier bytes cannot authorize this body.
  if (mode === 'walk') queue?.deleteItemQuestions(identity);
  const floor = ownerTier === 'secure' ? 'secure' : 'public';
  const decision: TierDecision = scanned && ownerOverrideSecretReview(scanned.reasons) ? {
    ...scanned,
    metadataTier: maxTier(record.metadataTier, scanned.metadataTier),
  } : {
    metadataTier: heldTier(floor, record.metadataTier, record.targetMetadataTier),
    contentTier: heldTier(floor, record.contentTier, record.targetContentTier),
    decidedBy: 'default',
    reasons: [
      ...record.reasons.filter(reason => !reason.startsWith('content:') && !reason.startsWith('override:')),
      HELD_UNTIL_JUDGED_REASON,
      'content:sniffer:undecided:undecided',
    ],
    state: 'pending',
    contentRead: true,
    metadataPending: record.metadataPending,
    contentPending: true,
    metadataForced: record.metadataForced && record.decidedBy !== 'override',
    metadataFlagged: record.metadataFlagged,
    engineVersion: TIER_CLASSIFIER_VERSION,
    mapRevision: TIER_MAP_REVISION,
    snifferId: 'undecided',
  };
  const placement = set.placementFor(decision);
  if (mode === 'walk') {
    const digest = contentDigestReason(text);
    decision.reasons.push(LEGACY_PERSONAL_BODY_REASON);
    if (!decision.reasons.includes(digest)) decision.reasons.push(digest);
    const { outcome } = ledger.recordLegacyPersonalHold(identity, decision, placement, digest, { generation: record.generation, override }, copy?.layers === 'metadata' ? personal.corpusId : undefined);
    return outcome === 'queued_move' ? 'held' : 'retry';
  }
  const pending = resuming ? record : ledger.recordRoutedPlacement(identity, decision, placement).record;
  moveRestoredItemToHold({ set, identity, decision, expectedGeneration: pending.generation });
  return 'held';
}

function exactPersonalReceipt(record: TierLedgerRecord, text: string, override: ItemTierOverride | undefined,
  image: ImageJudgmentSignal | undefined): boolean {
  return record.state === 'current' && !record.metadataPending
    && (record.contentTier === 'private' || record.contentTier === 'public')
    && (record.metadataTier === 'private' || record.metadataTier === 'public')
    && (record.decidedBy !== 'override' || override?.kind === 'tier')
    && personalContentAuthorized(record, text, override?.kind === 'not_secret', override, image);
}

function heldTier(floor: TierKey, current: TierKey, target: TierKey | null): TierKey {
  const tier = maxTier(floor, maxTier(current, target ?? current));
  return tier === 'secrets' ? 'secure' : tier;
}
