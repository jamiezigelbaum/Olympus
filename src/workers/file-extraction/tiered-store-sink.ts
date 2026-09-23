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
 *   - A LEGACY item (stored before per-tier routing, never routed) takes the
 *     plain store sink over the lane's own store, byte-for-byte the path it
 *     always took. Nothing about it moves.
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
import { classifyContentTier, maxTier, type TierDecision } from '../classification/tier-classifier.ts';
import type { TierCopy, TierPlacementPlan } from '../classification/tier-ledger.ts';
import type { ConnectorStoreOwnershipKind, LocalConnectorStore } from '../connector-store/index.ts';
import type { ConnectorStoreTierClassification } from '../connector-store/tier-placement.ts';
import {
  TIER_DOMAIN_ORDER,
  TIERED_STORE_SET_HANDOFF_CONNECTOR_ID,
  type TieredStoreSet,
} from '../connector-store/tiered-store-set.ts';
import {
  EXTRACTION_SINK_SKIPPED_ITEM_MISSING,
  EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE,
  createConnectorStoreExtractionSink,
  planExtractionSinkWrite,
} from './store-sink.ts';
import type {
  ExtractionClaimReader,
  ExtractionSink,
  ExtractionSinkRequest,
  ExtractionSinkResult,
} from './types.ts';

/**
 * The routed item's content decision needs different stores than it has:
 * the move is queued (hidden first on a raise) and this text is not written.
 */
export const EXTRACTION_SINK_SKIPPED_TIER_MOVE_QUEUED = EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE;

export interface TieredStoreExtractionSinkOptions {
  set: TieredStoreSet;
  syncConnectorId: string;
  ownerConnectorId: string;
  ownershipKind: ConnectorStoreOwnershipKind;
  claims?: ExtractionClaimReader;
  tierClassification?: ConnectorStoreTierClassification;
}

export function createTieredStoreExtractionSink(options: TieredStoreExtractionSinkOptions): ExtractionSink {
  const set = options.set;
  const sinkFor = (store: LocalConnectorStore, recordContentTier: boolean): ExtractionSink =>
    createConnectorStoreExtractionSink({
      store,
      classify: (item: RawItem) => buildSourceSensitivity({
        // The row's OWN stored tier, read live, as the plain sink always did;
        // a row written moments ago for this landing rests at its leg's tier.
        trustTier: store.activeLocalItemRow(item.identity.localItemId)?.trustTier
          ?? set.restingTierFor(store.trustDomain),
        trustDomain: store.trustDomain,
      }),
      syncConnectorId: options.syncConnectorId,
      ownerConnectorId: options.ownerConnectorId,
      ownershipKind: options.ownershipKind,
      ...(options.claims ? { claims: options.claims } : {}),
      ...(options.tierClassification ? { tierClassification: options.tierClassification } : {}),
      ...(recordContentTier ? {} : { recordContentTier: false }),
    });

  return {
    async accept(request: ExtractionSinkRequest): Promise<ExtractionSinkResult> {
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
      if (!ledger.isRouted(identity)) {
        const legacy = legacyStoreFor(set, ref.localItemId);
        if (!legacy) return skipped(EXTRACTION_SINK_SKIPPED_ITEM_MISSING);
        return sinkFor(legacy, true).accept(request);
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

      const override = ledger.getOverride(identity);
      const content = classifyContentTier(
        {
          text: request.text,
          metadataTier: record.metadataTier,
          metadataForced: record.metadataForced,
          metadataFlagged: record.metadataFlagged,
        },
        {
          ...(options.tierClassification?.sensitivityMap ? { sensitivityMap: options.tierClassification.sensitivityMap } : {}),
          ...(options.tierClassification?.sniffer ? { sniffer: options.tierClassification.sniffer } : {}),
          ...(override ? { override } : {}),
        },
      );
      const decision: TierDecision = {
        metadataTier: record.metadataTier,
        contentTier: maxTier(content.contentTier, record.metadataTier),
        decidedBy: content.decidedBy,
        reasons: [
          ...record.reasons.filter((reason) => !reason.startsWith('content:')),
          ...content.reasons,
        ],
        state: record.metadataPending || content.contentPending ? 'pending' : 'current',
        contentRead: true,
        metadataPending: record.metadataPending,
        contentPending: content.contentPending,
        metadataForced: record.metadataForced,
        metadataFlagged: record.metadataFlagged,
        engineVersion: content.engineVersion,
        mapRevision: content.mapRevision,
        snifferId: content.snifferId,
      };

      if (decision.contentTier === 'secrets') {
        recordSecret(set, plan.item, request.text, {
          namesReleasable: record.metadataTier === 'public' || record.metadataTier === 'private',
          sourceScope: anchorStore.activeLocalItemRow(ref.localItemId)?.sourceScope,
        });
        const recorded = ledger.recordRoutedPlacement(identity, decision, { copies: [], embedHold: false });
        for (const copy of recorded.previousCopies) {
          const domain = set.domainForCorpus(copy.corpusId);
          const store = domain ? set.store(domain) : undefined;
          store?.tombstoneCopy(plan.item.identity, { connectorId: TIERED_STORE_SET_HANDOFF_CONNECTOR_ID, trustTier: 'S5' });
        }
        ledger.removeCopies(identity);
        return skipped(EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE);
      }

      const placement = set.placementFor(decision);
      const contentCopy = placement.copies.find((copy) => copy.layers !== 'metadata');
      const contentStore = contentCopy ? set.store(contentCopy.trustDomain, { create: true }) : undefined;
      if (!contentCopy || !contentStore) return skipped(EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE);

      if (record.contentRead) {
        // Text already landed once: a re-judgment. Same stores: enrich the
        // content copy in place. Different stores: queue the move, write nothing.
        if (!samePlacement(current, placement)) {
          ledger.recordRoutedPlacement(identity, decision, placement);
          return skipped(EXTRACTION_SINK_SKIPPED_TIER_MOVE_QUEUED);
        }
        const result = await sinkFor(contentStore, false).accept(request);
        if (result.accepted) ledger.recordRoutedPlacement(identity, decision, placement);
        return result;
      }

      // First landing. The names stay exactly where they are.
      const namesStay = placement.copies.some((copy) => copy.corpusId === anchor.corpusId && copy.layers !== 'content');
      if (!namesStay) {
        ledger.recordRoutedPlacement(identity, decision, placement);
        return skipped(EXTRACTION_SINK_SKIPPED_TIER_MOVE_QUEUED);
      }
      if (contentStore !== anchorStore) {
        // The content tier's copy is STAGED before its row is written, so the
        // row is hidden from every read, count and embedding until the
        // landing below makes it current.
        ledger.stageLandingCopy(identity, contentCopy, {
          expectedGeneration: record.generation,
          embedHold: placement.embedHold,
        });
      }
      if (contentStore !== anchorStore && !contentStore.activeLocalItemRow(ref.localItemId)) {
        await contentStore.syncFromConnector(
          singleItemConnector(contentStore, { ...plan.item, content: { kind: 'metadata_only' } }),
          {
            fetchContent: false,
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
      const result = await sinkFor(contentStore, false).accept(request);
      if (!result.accepted) return result;
      ledger.landExtractedContent(identity, decision, placement, { expectedGeneration: record.generation });
      return result;
    },
  };
}

function skipped(skippedReason: string): ExtractionSinkResult {
  return { accepted: false, chunksIndexed: 0, chunksAwaitingEmbedding: 0, skippedReason };
}

/**
 * The lane's own store that holds a legacy item's row: the first legacy leg
 * with the row, else the first legacy leg (the plain sink then reports the
 * item missing exactly as before).
 */
function legacyStoreFor(set: TieredStoreSet, localItemId: string): LocalConnectorStore | undefined {
  const legacy = TIER_DOMAIN_ORDER
    .filter((domain: SourceTrustDomain) => set.legSpec(domain)?.legacy === true)
    .flatMap((domain) => {
      const store = set.store(domain);
      return store ? [store] : [];
    });
  return legacy.find((store) => store.activeLocalItemRow(localItemId) !== undefined) ?? legacy[0];
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
