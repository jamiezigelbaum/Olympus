import type { SourceItemIdentity } from '../../core/source-index/types.ts';
import { OperationError } from '../../core/operation-error.ts';
import {
  classifyItemTiers, contentDigestReason, contentReceiptRefusal, contentSecretFindingKinds, HELD_UNTIL_JUDGED_REASON, isImageMediaType,
  LEGACY_PERSONAL_BODY_REASON, maxTier, ownerOverrideSecretReview, personalContentAuthorized, TIER_CLASSIFIER_VERSION, TIER_MAP_REVISION,
  type ItemTierOverride, type ImageJudgmentSignal, type TierDecision, type TierKey,
} from '../classification/tier-classifier.ts';
import { detectSecretFindingKinds } from '../classification/engine.ts';
import type { TierLedger, TierLedgerRecord } from '../classification/tier-ledger.ts';
import type { TierSnifferStore } from '../classification/sniffer-store.ts';
import { imageJudgmentSignal } from '../source-index/media-judge.ts';
import type { ConnectorStoreItemNames, LocalConnectorStore } from './local-index.ts';
import { settleSecretsCopies } from './secrets-disposition.ts';
import { storedSignals } from './stored-names.ts';
import { moveRestoredItemToHold, TIER_MOVE_CONNECTOR_ID } from './tier-move.ts';
import { recordSecretLocation, settleRoutedSecrets } from './tier-rejudge.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

/** Put-back owns the stopped stores. A live pass hides the copy and leaves the transfer to the mover. */
export function placePersonalBody(set: TieredStoreSet, personal: LocalConnectorStore,
  item: { identity: SourceItemIdentity; mimeType?: string; text: string },
  queue: TierSnifferStore | undefined, mode: 'restore' | 'walk',
  walk?: { previousLedger?: TierLedger; movesAvailable: boolean; recordedOnly?: boolean }): 'unchanged' | 'settled' | 'held' | 'secrets' | 'retry' | 'waiting' {
  const { ledger } = set;
  const { identity, text } = item;
  if (mode === 'restore' && !text.trim()) return 'unchanged';
  const current = ledger.getCurrent(identity);
  const previousLedger = walk?.previousLedger;
  const movesAvailable = walk?.movesAvailable ?? true;
  const previous = previousLedger?.getCurrent(identity);
  if (walk?.recordedOnly && current?.routed) return 'unchanged';
  const recorded = mode === 'walk' && !current?.routed
    ? [current, previous].filter((record): record is TierLedgerRecord => protectedUnroutedReceipt(record)) : [];
  if (walk?.recordedOnly && !recorded.length) return 'unchanged';
  if (recorded.length && ledger.writeIntent(identity)) return 'retry';
  // Stored text cannot supply the original digest of a legacy override.
  const readOverride = (source: TierLedger) => movesAvailable ? source.observeOverrideText(identity) : source.getOverride(identity);
  const override = readOverride(ledger);
  const previousOverride = !override && !current?.routed && previousLedger ? readOverride(previousLedger) : undefined;
  const effectiveOverride = override ?? previousOverride;
  const authorityUnchanged = () => JSON.stringify(ledger.getCurrent(identity)) === JSON.stringify(current)
    && JSON.stringify(ledger.getOverride(identity)) === JSON.stringify(override)
    && (!previousLedger || (JSON.stringify(previousLedger.getCurrent(identity)) === JSON.stringify(previous)
      && (override !== undefined || JSON.stringify(previousLedger.getOverride(identity)) === JSON.stringify(previousOverride))));
  const copies = ledger.copies(identity);
  const copy = copies.find(copy => copy.corpusId === personal.corpusId && (mode === 'walk' || copy.layers !== 'metadata'));
  const digest = recorded.length ? contentDigestReason(text) : '';
  const matching = recorded.filter(record => record.state === 'current' && record.contentRead && !record.contentPending && !record.metadataPending
    && record.decidedBy !== 'override' && contentReceiptRefusal(record.reasons, digest) === undefined);
  const knownSecret = matching.find(secretDecision);
  const known = knownSecret ?? (recorded.some(secretDecision) ? undefined : matching[0]);
  const conflictingPhysicalBody = () => set.openStores().some(store => store.corpusId !== personal.corpusId
    && differentStoredBody(store, identity, text));
  const conflictingSecret = knownSecret && conflictingPhysicalBody();
  if (known && !effectiveOverride && !conflictingSecret) {
    const decision: TierDecision = {
      ...known,
      metadataTier: matching.reduce((tier, record) => maxTier(tier, record.metadataTier), known.metadataTier),
      contentTier: knownSecret ? 'secrets' : matching.reduce((tier, record) => maxTier(tier, record.contentTier), known.contentTier),
      decidedBy: known.decidedBy as TierDecision['decidedBy'],
      reasons: knownSecret ? known.reasons : [...known.reasons, LEGACY_PERSONAL_BODY_REASON],
      state: 'current',
      snifferId: 'ledger',
    };
    if (knownSecret) {
      const names = personal.exportItemNames(identity);
      if (!names) return 'retry';
      return settleLegacySecret(set, identity, decision, names, text, override, authorityUnchanged);
    }
    const settled = ledger.withMoveBatch(() => {
      if (!authorityUnchanged()) return false;
      const adopted = set.adoptLegacyItem(identity);
      if (!adopted) return false;
      const { outcome } = ledger.recordLegacyPersonalHold(identity, decision, set.placementFor(decision),
        undefined, { generation: adopted.generation, override });
      if (outcome !== 'queued_move') throw new OperationError('config_error', 'A recorded Private body could not be queued.');
      const sniffer = set.classification()?.sniffer;
      if (sniffer) ledger.markRejudged(identity, { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: sniffer.id });
      return true;
    });
    if (!settled) return 'retry';
    queue?.deleteItemQuestions(identity);
    return 'settled';
  }
  if (effectiveOverride?.kind !== 'not_secret' && (effectiveOverride?.tier === 'secrets'
    || [current, current?.routed ? undefined : previous].some(record => record
      && !(mode === 'walk' && protectedUnroutedReceipt(record))
      && (secretDecision(record) || record.targetMetadataTier === 'secrets' || record.targetContentTier === 'secrets')))) {
    if (!movesAvailable && !recorded.length) return 'waiting';
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
  if (recorded.length === 0 && currentAllowsPersonal && ownerTier !== 'secure'
    && [current, previous].some(record => record && exactPersonalReceipt(record, text, effectiveOverride, image))) return 'unchanged';
  if (current && recorded.length && ownerTier !== 'secure' && ownerTier !== 'secrets'
    && recorded.every(record => contentReceiptRefusal(record.reasons, digest) === 'content_receipt_mismatch')
    && exactPersonalReceipt(current, text, effectiveOverride, image) && !conflictingPhysicalBody()) {
    // The set's receipt covers the present bytes. Bind their placement so release
    // readers can retire the sidecar verdict for the previous body.
    return ledger.withMoveBatch(() => {
      if (!authorityUnchanged() || ledger.writeIntent(identity) || previousLedger?.writeIntent(identity)) return 'retry';
      return set.adoptLegacyItem(identity)?.routed ? 'settled' : 'retry';
    });
  }
  // A recorded hold is a hide-first raise. Its mover can transfer text without embeddings.
  if (!movesAvailable && !recorded.length) return 'waiting';
  // Put-back rejects a conflict before replacing the old question. A live
  // Secret disposition also needs to know that no other version would be
  // lost. The ordinary live move checks all copies under its writer locks.
  const conflict = () => ledger.copies(identity).some(other => {
    if (other.corpusId === personal.corpusId || other.state !== 'current'
      || (mode === 'restore' && (other.trustDomain !== 'secure_local' || other.layers === 'metadata'))) return false;
    return differentStoredBody(set.store(other.trustDomain), identity, text);
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
  const recordedWalk = mode === 'walk' && recorded.length > 0;
  const basis = recordedWalk ? (current ?? recorded[0]!) : (record ??= set.adoptLegacyItem(identity)!);
  if (mode === 'walk' && names && scanned?.contentTier === 'secrets') {
    const decision = { ...scanned, metadataTier: maxTier(basis.metadataTier, scanned.metadataTier) };
    if (recordedWalk && !conflictingPhysicalBody()) {
      return settleLegacySecret(set, identity, decision, names, text, override, authorityUnchanged);
    }
    if (!recordedWalk && !conflict()) {
      const settled = settleRoutedSecrets(set, identity, decision, names, {
        text, findingKinds: contentSecretFindingKinds(decision.reasons),
      }, { guard: { generation: basis.generation, override } });
      return settled ? 'secrets' : 'retry';
    }
  }
  // A question about earlier bytes cannot authorize this body.
  if (mode === 'walk') queue?.deleteItemQuestions(identity);
  const floor = ownerTier === 'secure' ? 'secure' : 'public';
  const decision: TierDecision = scanned && ownerOverrideSecretReview(scanned.reasons) ? {
    ...scanned,
    metadataTier: maxTier(basis.metadataTier, scanned.metadataTier),
  } : {
    metadataTier: heldTier(floor, basis.metadataTier, basis.targetMetadataTier),
    contentTier: heldTier(floor, basis.contentTier, basis.targetContentTier),
    decidedBy: 'default',
    reasons: [
      ...basis.reasons.filter(reason => !reason.startsWith('content:') && !reason.startsWith('override:')),
      HELD_UNTIL_JUDGED_REASON,
      'content:sniffer:undecided:undecided',
    ],
    state: 'pending',
    contentRead: true,
    metadataPending: basis.metadataPending,
    contentPending: true,
    metadataForced: basis.metadataForced && basis.decidedBy !== 'override',
    metadataFlagged: basis.metadataFlagged,
    engineVersion: TIER_CLASSIFIER_VERSION,
    mapRevision: TIER_MAP_REVISION,
    snifferId: 'undecided',
  };
  const placement = set.placementFor(decision);
  if (mode === 'walk') {
    const bodyDigest = digest || contentDigestReason(text);
    decision.reasons.push(LEGACY_PERSONAL_BODY_REASON);
    if (!decision.reasons.includes(bodyDigest)) decision.reasons.push(bodyDigest);
    const hold = () => {
      if (recordedWalk && !authorityUnchanged()) return 'retry';
      // A Secret decision for earlier bytes must no longer drive Secret
      // recovery while its replacement is queued for the Private hold.
      const base = current && !current.routed && protectedUnroutedReceipt(current) && secretDecision(current)
        ? ledger.recordDecision(identity, decision).record : current;
      const adopted = record ?? (base?.routed ? base : set.adoptLegacyItem(identity));
      if (!adopted) return 'retry';
      const { outcome } = ledger.recordLegacyPersonalHold(identity, decision, placement, bodyDigest,
        { generation: adopted.generation, override }, copy?.layers === 'metadata' ? personal.corpusId : undefined);
      if (recordedWalk && outcome !== 'queued_move') throw new OperationError('config_error', 'A recorded body could not be held.');
      return outcome === 'queued_move' ? 'held' : 'retry';
    };
    return recordedWalk ? ledger.withMoveBatch(hold) : hold();
  }
  const pending = resuming ? record! : ledger.recordRoutedPlacement(identity, decision, placement).record;
  moveRestoredItemToHold({ set, identity, decision, expectedGeneration: pending.generation });
  return 'held';
}

function settleLegacySecret(set: TieredStoreSet, identity: SourceItemIdentity, decision: TierDecision,
  names: ConnectorStoreItemNames, text: string, override: ItemTierOverride | undefined, authorityUnchanged: () => boolean): 'secrets' | 'retry' {
  const { ledger } = set;
  const recorded = ledger.withMoveBatch(() => {
    if (!authorityUnchanged() || ledger.writeIntent(identity)) return undefined;
    const adopted = set.adoptLegacyItem(identity);
    if (!adopted) return undefined;
    const placed = ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision), {
      guard: { generation: adopted.generation, override },
    });
    if (placed.outcome !== 'secrets') throw new OperationError('config_error', 'A recorded Secret could not be hidden.');
    const sourceVersion = names.identity.sourceVersion;
    ledger.putWriteIntent({ identity, kind: 'secret', connectorId: TIER_MOVE_CONNECTOR_ID, itemFamily: identity.family,
      ...(sourceVersion === undefined ? {} : { version: sourceVersion }) });
    const locations = set.secrets();
    if (locations) recordSecretLocation(locations, decision, names, { text, findingKinds: contentSecretFindingKinds(decision.reasons) });
    return placed;
  });
  if (!recorded) return 'retry';
  settleSecretsCopies({
    ledger, identity, copies: recorded.previousCopies, connectorId: TIER_MOVE_CONNECTOR_ID,
    storeFor: corpusId => {
      const domain = set.domainForCorpus(corpusId);
      return domain && set.store(domain);
    },
  });
  const sourceVersion = names.identity.sourceVersion;
  ledger.clearWriteIntent(identity, { kind: 'secret', ...(sourceVersion === undefined ? {} : { version: sourceVersion }) });
  return 'secrets';
}

function protectedUnroutedReceipt(record: TierLedgerRecord | undefined): boolean {
  return !!record && !record.routed && [record.metadataTier, record.contentTier].some(tier => tier === 'secure' || tier === 'secrets')
    && record.reasons.some(reason => reason.startsWith('content:sha256:'));
}

function secretDecision(record: TierLedgerRecord): boolean {
  return record.contentTier === 'secrets' || record.metadataTier === 'secrets';
}

function differentStoredBody(store: LocalConnectorStore | undefined, identity: SourceItemIdentity, text: string): boolean {
  const otherText = store?.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('');
  return !!otherText && otherText !== text;
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
