/**
 * The extraction sink for a tiered store set whose text arrives after listing
 * (design docs/design/per-item-four-tier-classification.md, sections 2 and
 * 3.2; TieredStoreSetOptions.contentArrivesLater).
 *
 * This module is enrolled in the architecture guard's source-agnostic list:
 * it names no source family. Doc comments here are always multi-line blocks.
 *
 * Two kinds of item reach it:
 *
 *   - An unrouted item gets a placement for newly read text
 *     before the representation is written.
 *   - A ROUTED item has its names in its metadata tier's store. Its text is
 *     judged here (pass 2 of the shared classifier, which can only raise the
 *     metadata tier) and lands in the CONTENT tier's store: the same store,
 *     whose copy then serves both layers, or a more private one, whose row is
 *     written first and stays hidden until the ledger records its copy. That
 *     first landing is a placement, not a move: no store served the item's
 *     content before it. Secrets are stored nowhere and only their location is
 *     kept. A later re-judgment of text that already landed is a move, which
 *     is queued and never performed here.
 */

import type { RawItem, SourceConnector, SourceConnectorListPage } from '../../core/contracts.ts';
import {
  buildSourceSensitivity,
  type SourceItemIdentity,
  type SourceTrustDomain,
} from '../../core/source-index/types.ts';
import { detectSecretFindingKinds } from '../classification/engine.ts';
import { CONTENT_NAMES_ONLY_LIFTED_REASON, CONTENT_NAMES_ONLY_REASON, OWNER_OVERRIDE_SECRET_REVIEW_REASON, arrivalOrderedSniffer, classifyContentTier, contentHeldForJudgment, heldUntilJudged, maxTier, namesDecidedByOwner, type TierDecision, type TierKey } from '../classification/tier-classifier.ts';
import { copyServingLayer, isFailSafeMissingContentQuestion, placementIsRaise, trustDomainRank, type TierCopy, type TierLedgerRecord, type TierPlacementPlan } from '../classification/tier-ledger.ts';
import type { ConnectorStoreOwnershipKind, LocalConnectorStore } from '../connector-store/index.ts';
import { parentNamesContext } from '../connector-store/parent-context.ts';
import { storedSignals } from '../connector-store/stored-names.ts';
import { decideItemTiers, secretFencedSniffer, type ConnectorStoreTierClassification } from '../connector-store/tier-placement.ts';
import type { ConnectorStoreRepresentationRestoreOptions } from '../connector-store/local-index.ts';
import { imageJudgmentSignal, type MediaJudgment } from '../source-index/media-judge.ts';
import { settleSecretsCopies } from '../connector-store/secrets-disposition.ts';
import {
  TIER_DOMAIN_ORDER,
  TIER_KEY_TRUST_DOMAIN,
  TIERED_STORE_SET_HANDOFF_CONNECTOR_ID,
  type TieredStoreSet,
} from '../connector-store/tiered-store-set.ts';
import {
  EXTRACTION_SINK_SKIPPED_CLAIM_SUPERSEDED,
  EXTRACTION_SINK_SKIPPED_ITEM_MISSING,
  EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE,
  EXTRACTION_SINK_SKIPPED_SECRETS,
  EXTRACTION_SINK_SKIPPED_SOURCE_VERSION_STALE,
  EXTRACTION_SINK_SKIPPED_TIER_MOVE_QUEUED,
  createConnectorStoreExtractionSink,
  extractionWriteClaim,
  planExtractionSinkWrite,
} from './store-sink.ts';
import type {
  ExtractionClaimReader,
  ExtractionSink,
  ExtractionSinkRequest,
  ExtractionSinkResult,
} from './types.ts';



export interface TieredStoreExtractionSinkOptions {
  set: TieredStoreSet;
  syncConnectorId: string;
  ownerConnectorId: string;
  ownershipKind: ConnectorStoreOwnershipKind;
  claims?: ExtractionClaimReader;
  tierClassification?: ConnectorStoreTierClassification;
  /**
   * The legacy store this sink's corpus serves, in a lane with several: an
   * item the set never routed lands there when that store holds it, exactly
   * as the corpus's plain sink did.
   */
  home?: SourceTrustDomain;
}

export function createTieredStoreExtractionSink(options: TieredStoreExtractionSinkOptions): ExtractionSink {
  const set = options.set;
  // The owner's map and sniffer judge the text exactly as they judged the
  // names at listing: the set's own classification unless one is given,
  // resolved per landing so an edited map or rules file applies at once.
  const classificationNow = (): ConnectorStoreTierClassification | undefined => options.tierClassification ?? set.classification();
  const sinkFor = (
    store: LocalConnectorStore,
    route?: ConnectorStoreRepresentationRestoreOptions['route'],
    routed = true,
  ): ExtractionSink =>
    createConnectorStoreExtractionSink({
      store,
      classify: (item: RawItem) => buildSourceSensitivity({
        trustTier: store.activeLocalItemRow(item.identity.localItemId)?.trustTier
          ?? set.restingTierFor(store.trustDomain),
        trustDomain: store.trustDomain,
      }),
      syncConnectorId: options.syncConnectorId,
      ownerConnectorId: options.ownerConnectorId,
      ownershipKind: options.ownershipKind,
      ...(options.claims ? { claims: options.claims } : {}),
      ...(route ? { route } : {}),
      recordContentTier: false,
      secretsFloor: false,
      ...(routed ? { mediaJudgment: (sha256: string) => setMediaJudgment(set, sha256) } : {}),
    });

  return {
    async accept(request: ExtractionSinkRequest): Promise<ExtractionSinkResult> {
      if (request.onDemandGrantCurrent?.() === false) return skipped(EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE);
      const ref = request.ref;
      // The ledger keys an item by its conversation too; the ref carries none,
      // so it comes from whichever store holds the row.
      const stored = TIER_DOMAIN_ORDER
        .map((domain) => set.store(domain)?.activeLocalItemRow(ref.localItemId)?.identity)
        .find((candidate) => candidate !== undefined
          && candidate.provider === ref.provider
          && candidate.accountScope === ref.accountScope
          && candidate.providerItemId === ref.providerItemId);
      const identity = stored ?? { provider: ref.provider, accountScope: ref.accountScope, providerItemId: ref.providerItemId };
      const ledger = set.ledger;
      const recorded = ledger.getCurrent(identity);
      if (!recorded?.routed || representationLandingDue(recorded)) {
        const retry = recorded?.routed ? ledger.copies(identity).find((copy) => copy.state === 'current' && copy.layers === 'metadata') : undefined;
        const legacy = retry ? set.store(retry.trustDomain) : legacyStoreFor(set, ref.localItemId, options.home);
        if (!legacy) return skipped(EXTRACTION_SINK_SKIPPED_ITEM_MISSING);
        const route = tieredRepresentationLanding({
          set, anchor: legacy, classification: classificationNow,
        });
        return sinkFor(legacy, route, recorded?.routed === true).accept(request);
      }

      const record = ledger.getCurrent(identity);
      if (!record || record.state === 'moving') return skipped(EXTRACTION_SINK_SKIPPED_TIER_MOVE_QUEUED);
      const current = ledger.copies(identity).filter((copy) => copy.state === 'current');
      const anchor = current.find((copy) => copy.layers !== 'content');
      const anchorDomain = anchor ? set.domainForCorpus(anchor.corpusId) : undefined;
      const anchorStore = anchorDomain ? set.store(anchorDomain) : undefined;
      if (!anchor || !anchorStore) return skipped(EXTRACTION_SINK_SKIPPED_ITEM_MISSING);
      const plan = planExtractionSinkWrite(anchorStore, request);
      if ('skippedReason' in plan) return skipped(plan.skippedReason);

      const writeClaim = extractionWriteClaim(request);
      if (request.claim && options.claims && !options.claims.holdsExtractionClaim(request.claim)
        || writeClaim && current.some((copy) => set.store(copy.trustDomain)?.hasNewerItemWriteClaim(plan.item.identity, writeClaim))) {
        return skipped(EXTRACTION_SINK_SKIPPED_CLAIM_SUPERSEDED);
      }
      const currentVersion = anchorStore.itemMetadataSnapshot(plan.item.identity)?.sourceVersion;
      if (plan.item.identity.sourceVersion && currentVersion && plan.item.identity.sourceVersion !== currentVersion) {
        return skipped(EXTRACTION_SINK_SKIPPED_SOURCE_VERSION_STALE);
      }

      const read = ledger.classificationRead(identity, request.text);
      const tierClassification = classificationNow();
      const override = read.override;
      const itemTitle = stringMetadata(plan.item, ['title', 'name', 'subject']);
      const itemPath = stringMetadata(plan.item, ['locatorUri', 'pathDisplay']);
      // The photo judge's verdict on this exact picture, wherever in the set
      // it was judged. None: the picture is unjudged and its content Private.
      const imageJudgment = plan.media ? setMediaJudgment(set, plan.media.sha256) : undefined;
      // The lane's hold, or the one the listing-time decision recorded.
      // An item settled fail-safe Private for a content question that could not
      // exist yet (its text had not been read) is still owed a verdict: its
      // text is judged now and held Private meanwhile, never placed lower on
      // a Personal-first guess. Held that way (pending, hidden from search and
      // embedding) it is placed like any held item, so the store accepts it.
      // So is one the owner kept names only and now lets be read: its names
      // verdict never covered this text, so the text is held the same way
      // until judged, never served on that verdict or a Personal-first guess.
      // The names-only reasons say no text was ever read, whatever the read flag says: an
      // owner override that was undone keeps the flag it set (a queued move never lowers it).
      const settledUnread = (!record.contentRead && record.reasons.some(isFailSafeMissingContentQuestion))
        || record.reasons.some((reason) => reason === CONTENT_NAMES_ONLY_REASON || reason === CONTENT_NAMES_ONLY_LIFTED_REASON);
      const holdUntilJudged = tierClassification?.holdContentUntilJudged === true
        || set.holdsContentUntilJudged() || heldUntilJudged(record.reasons) || settledUnread
        // A child listed before placement recorded its hold still has its parent link.
        || anchorStore.parentLocalItemIdOf(identity) !== undefined;
      const parentContext = tierClassification?.sniffer ? parentNamesContext(set, identity) : undefined;
      const judgeStarted = Date.now();
      const content = classifyContentTier(
        {
          text: request.text,
          // Extraction text does not prove the underlying file/media is trivial.
          hasNonTextContent: true,
          ...(read.secret ? { heldSecret: true } : {}),
          metadataTier: record.metadataTier,
          metadataForced: record.metadataForced,
          metadataFlagged: record.metadataFlagged,
          metadataOwnerDecided: namesDecidedByOwner(record.reasons),
          ...(itemTitle ? { title: itemTitle } : {}),
          ...(itemPath ? { path: itemPath } : {}),
          mimeType: plan.item.mimeType,
          ...(imageJudgment ? { imageJudgment: imageJudgmentSignal(imageJudgment) } : {}),
          ...(holdUntilJudged ? { holdUntilJudged: true } : {}),
          // A child is judged on its own text, with its parent's names as context for the model.
          ...(parentContext ? { parentContext } : {}),
          subject: identity,
        },
        {
          ...(tierClassification?.sniffer ? { sniffer: arrivalOrderedSniffer(secretFencedSniffer(tierClassification.sniffer, ledger, identity, read), ledger.newArrival(identity, { consume: true })
            // A file read on demand is judged as a new arrival: a question is waiting on it.
            || anchorStore.readOnDemand(ref.localItemId, ref.sourceVersion ?? '')) } : {}),
          ...(override ? { override } : {}),
          ...(tierClassification?.retirePublic ? { retirePublic: true } : {}),
        },
      );
      if (content.reasons.includes(OWNER_OVERRIDE_SECRET_REVIEW_REASON)) {
        // Stage the changed body directly in Private under the representation write fence.
        const route = tieredRepresentationLanding({ set, anchor: anchorStore, classification: classificationNow, replaceStoredContent: true });
        return sinkFor(anchorStore, route).accept(request);
      }
      if (!content.contentPending && anchorStore.readOnDemand(ref.localItemId, ref.sourceVersion ?? '')) {
        console.info(`[olympus:on-demand] step=judge count=1 ms=${Math.max(0, Date.now() - judgeStarted)}`);
      }
      // An unusable map or rules file: the content decision is held pending
      // (Private, embedding held) rather than made without them.
      const held = tierClassification?.unavailableReason !== undefined && content.contentTier !== 'secrets';
      const contentPending = content.contentPending || held;
      const decision = set.checkedBodyDecision(plan.item.identity, {
        metadataTier: record.metadataTier,
        contentTier: maxTier(content.contentTier, record.metadataTier),
        decidedBy: content.decidedBy,
        reasons: [
          ...record.reasons.filter((reason) => !reason.startsWith('content:')),
          ...content.reasons,
          ...(held ? [`content:${tierClassification!.unavailableReason}`] : []),
        ],
        state: record.metadataPending || contentPending ? 'pending' : 'current',
        contentRead: true,
        metadataPending: record.metadataPending,
        contentPending,
        metadataForced: record.metadataForced,
        metadataFlagged: record.metadataFlagged,
        engineVersion: content.engineVersion,
        mapRevision: content.mapRevision,
        snifferId: content.snifferId,
      }, request.text, imageJudgment && imageJudgmentSignal(imageJudgment));

      if (decision.contentTier === 'secrets') {
        recordSecret(set, plan.item, request.text, {
          namesReleasable: record.metadataTier === 'public' || record.metadataTier === 'private',
          sourceScope: anchorStore.activeLocalItemRow(ref.localItemId)?.sourceScope,
        });
        const recorded = ledger.recordRoutedPlacement(identity, decision, { copies: [], embedHold: false });
        // Hidden by that write; tombstoned now or kept for a purge, per the
        // one Secrets policy (connector-store/secrets-disposition.ts).
        settleSecretsCopies({
          ledger,
          identity: plan.item.identity,
          copies: recorded.previousCopies,
          storeFor: (corpusId) => {
            const domain = set.domainForCorpus(corpusId);
            return domain ? set.store(domain) : undefined;
          },
          connectorId: TIERED_STORE_SET_HANDOFF_CONNECTOR_ID,
        });
        return skipped(EXTRACTION_SINK_SKIPPED_SECRETS);
      }

      // A first landing places the item as one whose text arrives after
      // listing (its names stay), also in a lane where only some items' does.
      // A re-judgment places it as every caller with only a decision does, so
      // the two never disagree into a move and back.
      let placement = set.placementFor(decision, record.contentRead ? {} : { contentArrivesLater: true });
      const fromContent = copyServingLayer(current, 'content');
      const toContent = copyServingLayer(placement.copies, 'content');
      // An edited Private copy waits in place for its new text's answer,
      // just like an inline sync. Record the new decision's baseline so a
      // Personal answer can lower it; the old tier is not a new-text floor.
      if (record.contentRead && decision.contentPending && fromContent && toContent
        && trustDomainRank(toContent.trustDomain) < trustDomainRank(fromContent.trustDomain)
        && !placementIsRaise(current, placement.copies)) {
        placement = { copies: current, embedHold: true };
      }
      const contentCopy = placement.copies.find((copy) => copy.layers !== 'metadata');
      const contentStore = contentCopy ? set.store(contentCopy.trustDomain, { create: true }) : undefined;
      if (!contentCopy || !contentStore) return skipped(EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE);

      if (record.contentRead) {
        // Text already landed once: a re-judgment. Same stores: enrich the
        // content copy in place. Different stores: queue the move.
        if (!samePlacement(current, placement)) {
          if (!placementIsRaise(current, placement.copies)) {
            // A LOWERING move copies whatever the source store holds, and the
            // verdict just reached judged THIS text. If the file was edited,
            // the store still holds the older text, which the new verdict
            // never judged (it may be Private and about to reach a store that
            // may be shared). So the text in hand first replaces the old
            // where the content already rests, which stays at least as
            // private as the old; the queued move then carries the text the
            // verdict is about. A raise needs no such step: it only moves
            // content to a more private store.
            const resting = current.find((copy) => copy.layers !== 'metadata');
            const restingDomain = resting ? set.domainForCorpus(resting.corpusId) : undefined;
            const restingStore = restingDomain ? set.store(restingDomain) : undefined;
            if (!restingStore) return skipped(EXTRACTION_SINK_SKIPPED_ITEM_MISSING);
            const replaced = await sinkFor(restingStore).accept(request);
            if (!replaced.accepted) return replaced;
          }
          if (request.onDemandGrantCurrent?.() === false) return skipped(EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE);
          ledger.recordRoutedPlacement(identity, decision, placement);
          return skipped(EXTRACTION_SINK_SKIPPED_TIER_MOVE_QUEUED);
        }
        const result = await sinkFor(contentStore).accept(request);
        if (request.onDemandGrantCurrent?.() === false) return skipped(EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE);
        if (result.accepted) ledger.recordRoutedPlacement(identity, decision, placement);
        return result;
      }

      // First landing. The names stay exactly where they are.
      const namesStay = placement.copies.some((copy) => copy.corpusId === anchor.corpusId && copy.layers !== 'content');
      if (!namesStay) {
        if (decision.contentPending && !contentPending) {
          // A provisional Personal default has no body authority. Stage the
          // incoming text and its names together in Private on unsplit sets.
          const route = tieredRepresentationLanding({
            set, anchor: anchorStore, classification: classificationNow, replaceStoredContent: true,
          });
          return sinkFor(anchorStore, route).accept(request);
        }
        ledger.recordRoutedPlacement(identity, decision, placement);
        return skipped(EXTRACTION_SINK_SKIPPED_TIER_MOVE_QUEUED);
      }
      if (anchorStore.readOnDemand(ref.localItemId, ref.sourceVersion ?? '')) {
        contentStore.grantOnDemandRead(ref.localItemId, ref.sourceVersion);
      }
      if (contentStore !== anchorStore) {
        // Bound to the set ledger before any routed copy lands there, so no
        // handle reads it without that ledger. The content tier's copy is
        // STAGED before its row is written: the row is hidden from every
        // read, count and embedding until the landing below makes it current.
        contentStore.bindTierSet(ledger);
        ledger.stageLandingCopy(identity, contentCopy, {
          expectedGeneration: record.generation,
          embedHold: placement.embedHold,
        });
      }
      let landingGeneration = record.generation;
      if (contentStore === anchorStore && settledUnread && record.contentTier === 'secure'
        && contentDomainOf(record) !== contentStore.trustDomain) {
        // The names store widens its copy to hold text only at the content
        // tier the ledger records (LocalConnectorStore.tierWriteAllowed). An
        // unread item can rest there at a tier that is no verdict on its text:
        // a fail-safe Private hold for a question that could not exist yet.
        // Judged lower now, that tier is recorded first, text still unread and
        // the copies unchanged, or the store refuses the text and the item
        // stays names-only for good. Only that hold: any other recorded raise
        // keeps the store's refusal, which never widens a lower copy.
        const unread = { ...decision, contentRead: false };
        landingGeneration = ledger.recordRoutedPlacement(
          identity,
          unread,
          set.placementFor(unread, { contentArrivesLater: true }),
          // As the fail-safe itself was recorded: a copy an aborted landing
          // staged is no move to queue.
          { guard: { generation: record.generation, override }, stagedLandingAllowed: true },
        ).record.generation;
      }
      const anchorScope = anchorStore.activeLocalItemRow(ref.localItemId)?.sourceScope;
      if (contentStore !== anchorStore && !contentStore.activeLocalItemRow(ref.localItemId)) {
        // A child's content row names its parent as the names row does, so each
        // store's row says whose child it is (child-visibility.ts).
        const parent = parentOf(set, anchorStore, identity);
        await contentStore.syncFromConnector(
          singleItemConnector(contentStore, {
            ...plan.item,
            ...(parent ? { identity: { ...plan.item.identity, parent } } : {}),
            content: { kind: 'metadata_only' },
          }),
          {
            fetchContent: false,
            // The content row carries the names row's approved-scope stamp, so
            // the scope read filter judges both copies the same way.
            ...(anchorScope ? { sourceScopeObservation: () => anchorScope } : {}),
            tierRouting: {
              route: () => ({
                kind: 'store',
                layer: 'content',
                sensitivity: buildSourceSensitivity({
                  trustTier: set.restingTierFor(contentCopy.trustDomain),
                  trustDomain: contentCopy.trustDomain,
                }),
              }),
            },
          },
        );
      }
      const result = await sinkFor(contentStore).accept(request);
      if (!result.accepted) return result;
      if (request.onDemandGrantCurrent?.() === false) return skipped(EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE);
      ledger.landExtractedContent(identity, decision, placement, { expectedGeneration: landingGeneration });
      return result;
    },
  };
}

// An interrupted landing retains the receipt for the text its writer owes.
export function representationLandingDue(record: TierLedgerRecord): boolean {
  return record.routed && record.state === 'pending' && !record.contentRead
    && record.reasons.some((reason) => reason.startsWith('content:sha256:'));
}

// Place newly read text under the existing representation write fence.
export function tieredRepresentationLanding(options: {
  set: TieredStoreSet;
  anchor: LocalConnectorStore;
  connector?: Pick<SourceConnector, 'classificationSignals'>;
  replaceStoredContent?: boolean;
  classification?: () => ConnectorStoreTierClassification | undefined;
}): NonNullable<ConnectorStoreRepresentationRestoreOptions['route']> {
  const { set, anchor } = options;
  const ledger = set.ledger;
  return ({ item, expectation, media }) => {
    if (item.content.kind !== 'text') return undefined;
    const { identity } = item;
    const prior = ledger.getCurrent(identity);
    if (prior?.routed && !representationLandingDue(prior)
      && (!options.replaceStoredContent || prior.state === 'moving')) return undefined;
    const classification = options.classification?.() ?? set.classification();
    const text = item.content.text;
    const source = anchor.exportItemCopy(identity);
    if (!source) return undefined;
    const connector = options.connector ?? { classificationSignals: () => storedSignals(source) };
    const read = ledger.classificationRead(identity, text);
    const override = read.override;
    const imageJudgment = media?.judgment ? imageJudgmentSignal(media.judgment) : undefined;
    const parentContext = classification?.sniffer ? parentNamesContext(set, identity) : undefined;
    let decision = decideItemTiers(connector, item, text, classification, ledger, {
      requireContentVerdict: imageJudgment?.verdict !== 'ordinary' || imageJudgment.textDecides === true,
      classificationRead: read,
      ...(parentContext ? { parentContext } : {}),
      ...(imageJudgment ? { imageJudgment } : {}),
    });
    if (decision.contentTier === 'secrets') {
      if (set.openStores().some((store) => {
        const copy = store.itemMetadataSnapshot(identity);
        return copy !== undefined && copy.sourceVersion !== source.identity.sourceVersion;
      })) return undefined;
      const adopted = set.adoptLegacyItem(identity);
      if (!adopted?.routed) return undefined;
      const { previousCopies } = ledger.recordRoutedPlacement(identity, decision, { copies: [], embedHold: false });
      return { refused: () => {
        recordSecret(set, item, text, {
          namesReleasable: decision.metadataTier === 'public' || decision.metadataTier === 'private',
          sourceScope: anchor.activeLocalItemRow(identity.localItemId)?.sourceScope,
        });
        settleSecretsCopies({
          ledger, identity, copies: previousCopies,
          storeFor: (corpusId) => {
            const domain = set.domainForCorpus(corpusId);
            return domain ? set.store(domain) : undefined;
          },
          connectorId: TIERED_STORE_SET_HANDOFF_CONNECTOR_ID,
        });
      } };
    }
    if (classification?.unavailableReason) {
      decision = { ...decision, state: 'pending', metadataPending: true, contentPending: true,
        reasons: [...decision.reasons, `content:${classification.unavailableReason}`] };
    }
    decision = set.checkedBodyDecision(identity, decision, text, imageJudgment);
    const hasLowerCopy = () => set.openStores().some(store =>
      trustDomainRank(store.trustDomain) < trustDomainRank(anchor.trustDomain) && store.itemPresence(identity).active);
    // A settled Private body can stay in its only legacy Private row.
    if (prior && !prior.routed && anchor.trustDomain === 'secure_local'
      && prior.state !== 'moving' && decision.contentTier === 'secure'
      && decision.state === 'current' && !contentHeldForJudgment(decision) && !read.secret && !hasLowerCopy()) {
      const preservedPlacementCurrent = () => {
        const current = ledger.getCurrent(identity);
        const now = ledger.classificationRead(identity);
        return current?.routed === false && current.generation === prior.generation && current.state === prior.state
          && !now.secret && now.scrubRevision === read.scrubRevision
          && JSON.stringify(now.override ?? null) === JSON.stringify(override ?? null)
          && !hasLowerCopy();
      };
      return {
        store: anchor,
        sensitivity: buildSourceSensitivity({ trustTier: set.restingTierFor(anchor.trustDomain), trustDomain: anchor.trustDomain }),
        prepare: () => ledger.withMoveBatch(preservedPlacementCurrent),
        landed: () => {
          ledger.withMoveBatch(() => {
            if (!preservedPlacementCurrent()) return;
            ledger.recordContentDecision(identity, {
              ...decision, reasons: decision.reasons.filter(reason => reason.startsWith('content:')),
            });
          });
        },
      };
    }
    const placement = set.placementFor(decision);
    const contentCopy = copyServingLayer(placement.copies, 'content');
    const store = contentCopy ? set.store(contentCopy.trustDomain, { create: true }) : undefined;
    if (!contentCopy || !store) return undefined;

    let prepared: TierLedgerRecord | undefined;
    return {
      store,
      sensitivity: buildSourceSensitivity({
        trustTier: set.restingTierFor(store.trustDomain), trustDomain: store.trustDomain,
      }),
      prepare: () => {
        const destinationRow = store.itemMetadataSnapshot(identity);
        if (destinationRow && destinationRow.sourceVersion !== source.identity.sourceVersion
          && !(prior && representationLandingDue(prior) && store.itemRepresentationCoverage(expectation).complete)) return false;
        const adopted = set.adoptLegacyItem(identity);
        if (!adopted?.routed) return false;

        // The source serves names while a separate destination is staged.
        prepared = ledger.recordRoutedPlacement(identity, {
          ...decision, state: 'pending', contentRead: false, contentPending: true,
          contentTier: store.trustDomain === 'secure_local' ? 'secure' : store.trustDomain === 'internal' ? 'private' : 'public',
        }, {
          copies: [{ corpusId: anchor.corpusId, trustDomain: anchor.trustDomain, layers: 'metadata' }],
          embedHold: placement.embedHold,
        }, { staleCopiesGone: true, guard: { generation: adopted.generation, override } }).record;
        if (store !== anchor) {
          store.bindTierSet(ledger);
          ledger.stageLandingCopy(identity, contentCopy, { expectedGeneration: prepared.generation, embedHold: placement.embedHold });
          if (anchor.readOnDemand(identity.localItemId, identity.sourceVersion ?? '')) {
            store.grantOnDemandRead(identity.localItemId, identity.sourceVersion);
          }
        }
        for (const copy of placement.copies) {
          const destination = set.store(copy.trustDomain, { create: true })!;
          destination.bindTierSet(ledger);
          if (!destination.itemPresence(identity).active) {
            destination.importItemCopy(source, {
              trustTier: set.restingTierFor(copy.trustDomain),
              syncConnectorId: TIERED_STORE_SET_HANDOFF_CONNECTOR_ID,
              layers: 'metadata',
            });
          }
        }
        return true;
      },
      landed: () => {
        store.withItemCopyWriteFence(identity, () => {
          if (!prepared || !store.itemRepresentationCoverage(expectation).complete) return;
          ledger.recordRoutedPlacement(identity, decision, placement, {
            staleCopiesGone: true, guard: { generation: prepared.generation, override },
          });
        });
      },
    };
  };
}

/**
 * The photo judge's verdict on a picture across the stores of the set. A
 * store may keep an older verdict (a hidden copy left behind by a move is
 * never judged again), so the most cautious one wins: sensitive, then
 * unjudged, and ordinary only when no store holds anything else.
 */
function setMediaJudgment(set: TieredStoreSet, mediaSha256: string): MediaJudgment | undefined {
  const rank = { sensitive: 2, unjudged: 1, ordinary: 0 } as const;
  let chosen: MediaJudgment | undefined;
  for (const domain of [...TIER_DOMAIN_ORDER].reverse()) {
    const judgment = set.store(domain)?.mediaJudgment(mediaSha256);
    if (judgment && (!chosen || rank[judgment.verdict] > rank[chosen.verdict])) chosen = judgment;
  }
  return chosen;
}

function skipped(skippedReason: string): ExtractionSinkResult {
  return { accepted: false, chunksIndexed: 0, chunksAwaitingEmbedding: 0, skippedReason };
}

/**
 * The lane's own store that holds a legacy item's row: the home store when it
 * holds it, else the first legacy leg with the row, else the first legacy leg
 * (the plain sink then reports the item missing exactly as before).
 */
function legacyStoreFor(
  set: TieredStoreSet,
  localItemId: string,
  home?: SourceTrustDomain,
): LocalConnectorStore | undefined {
  const homeStore = home !== undefined && set.legSpec(home)?.legacy === true ? set.store(home) : undefined;
  if (homeStore?.activeLocalItemRow(localItemId)) return homeStore;
  const legacy = TIER_DOMAIN_ORDER
    .filter((domain: SourceTrustDomain) => set.legSpec(domain)?.legacy === true)
    .flatMap((domain) => {
      const store = set.store(domain);
      return store ? [store] : [];
    });
  return legacy.find((store) => store.activeLocalItemRow(localItemId) !== undefined) ?? legacy[0];
}

/**
 * The store the ledger's recorded content tier puts the text in: the one a
 * store's write gate accepts it in on a first landing.
 */
function contentDomainOf(record: { contentTier: TierKey }): SourceTrustDomain | undefined {
  return record.contentTier === 'secrets' ? undefined : TIER_KEY_TRUST_DOMAIN[record.contentTier];
}

function samePlacement(current: readonly TierCopy[], placement: TierPlacementPlan): boolean {
  if (current.length !== placement.copies.length) return false;
  return placement.copies.every((planned) => current.some((copy) =>
    copy.corpusId === planned.corpusId && copy.layers === planned.layers));
}

/**
 * Location only: identity, locator, a title that itself passes the secret
 * scan (the index checks) and only when the names are not Private, finding
 * kinds, and the approved-scope stamp the lane put on the row, so a search
 * outside that scope never sees it. Never the text.
 */
function recordSecret(
  set: TieredStoreSet,
  item: RawItem,
  text: string,
  options: {
    namesReleasable: boolean;
    sourceScope: { accountGeneration: string; scopeRevision: string; folderKeys: readonly string[] } | undefined;
  },
): void {
  const index = set.secrets();
  if (!index) return;
  const title = stringMetadata(item, ['title', 'name', 'subject']);
  const locator = stringMetadata(item, ['locatorUri', 'pathDisplay', 'url']);
  const kinds = [...new Set([
    ...detectSecretFindingKinds(text),
    ...(title ? detectSecretFindingKinds(title) : []),
    ...(locator ? detectSecretFindingKinds(locator) : []),
  ])];
  index.record({
    identity: item.identity,
    ...(locator ? { locator } : {}),
    ...(title && options.namesReleasable ? { title } : {}),
    namesReleasable: options.namesReleasable,
    folderKeys: options.sourceScope?.folderKeys ?? [],
    ...(options.sourceScope
      ? { scopeGeneration: options.sourceScope.accountGeneration, scopeRevision: options.sourceScope.scopeRevision }
      : {}),
    findingKinds: kinds.length > 0 ? kinds : ['owner_marked_secret'],
    text,
  });
}

function stringMetadata(item: RawItem, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = item.metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * A one-item listing that writes the content tier's row for a landing.
 */
function singleItemConnector(store: LocalConnectorStore, item: RawItem): SourceConnector {
  return {
    id: TIERED_STORE_SET_HANDOFF_CONNECTOR_ID,
    family: store.family,
    authenticate: async () => {},
    fetchItem: async () => item,
    classificationSignals: () => ({}),
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: [item], done: true };
      })();
    },
  };
}

export type { SourceItemIdentity };

/**
 * The item a child came inside, as the names row of the child names it: its
 * provider id (from whichever store holds the parent's row) and its local id.
 * Undefined for an item that is not a child, or whose parent no store holds.
 */
function parentOf(
  set: TieredStoreSet,
  anchorStore: LocalConnectorStore,
  child: Parameters<LocalConnectorStore['parentLocalItemIdOf']>[0],
): { providerItemId: string; localItemId: string } | undefined {
  const localItemId = anchorStore.parentLocalItemIdOf(child);
  if (!localItemId) return undefined;
  for (const domain of TIER_DOMAIN_ORDER) {
    const row = set.store(domain)?.activeLocalItemRow(localItemId);
    if (row) return { providerItemId: row.identity.providerItemId, localItemId };
  }
  return undefined;
}
