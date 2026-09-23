// The tier move primitive (design docs/design/per-item-four-tier-classification.md,
// sections 3.3 and 4.2). Phase P3's migration and later steady-state
// re-judgments use it; phase P1b ships it and never runs it on existing data.
//
// A move of one ROUTED item between the stores of a tiered store set:
//
// 1. Stage: the ledger marks the item `moving` and stages the destination
//    copies, which are never searched. On a RAISE (more private) the source
//    copies are superseded FIRST, so the item is briefly unsearchable instead
//    of briefly visible in the lower tier.
// 2. Write: each destination store gets the data it lacks, copied from the
//    source store (no provider fetch). Vectors are copied when the
//    destination's embedding identity equals the one the vectors were minted
//    under and each chunk's input hash is unchanged — the Public <-> Personal
//    case, zero provider calls. Otherwise the destination embeds later, with
//    its own canonical model, as a first mint or a match: never a rebind.
// 3. Flip: one ledger write makes the destination current and supersedes the
//    source. Superseded copies are KEPT (never searched, served, counted or
//    exported), including cloud vectors after a raise (owner ruling
//    2026-09-23). Rollback is `TierLedger.rollbackMove`: a flip back, no
//    re-embed.
//
// A move to Secrets tombstones every copy (vectors deleted: the one mandatory
// deletion) and records the item's location in the secret-locations index.
// Every move appends one embedding-ledger entry with its chunk counts.

import type { SourceItemIdentity, SourceTrustDomain } from '../../core/source-index/types.ts';
import { detectSecretFindingKinds } from '../classification/engine.ts';
import type { TierKey } from '../classification/tier-classifier.ts';
import {
  copyServingLayer,
  placementIsRaise,
  type TierCopy,
  type TierCopyLayers,
} from '../classification/tier-ledger.ts';
import {
  appendEmbeddingLedgerEntry,
  type EmbeddingLedgerApprovedBy,
} from '../embedding-ledger.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import type { ConnectorStoreItemCopy } from './local-index.ts';
import { defaultStoreTrustTier } from './tier-placement.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

export const TIER_MOVE_CONNECTOR_ID = 'olympus_tier_move';

export type TierMoveEmbeddingIdentity = Pick<
  SourceEmbeddingProvider,
  'modelId' | 'provider' | 'backend' | 'dimension' | 'epochId' | 'configHash'
>;

export interface TierMoveOptions {
  set: TieredStoreSet;
  identity: Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId' | 'providerConversationId' | 'family' | 'localItemId'>;
  target: { metadataTier: TierKey; contentTier: TierKey };
  /**
   * Each destination store's canonical embedding identity. Vectors are copied
   * only into a store whose identity is given here and matches the vectors'.
   */
  vectorIdentities?: Partial<Record<SourceTrustDomain, TierMoveEmbeddingIdentity>>;
  /** Where to record the move. Omitted: nothing is appended (tests only). */
  embeddingLedger?: { path: string; approvedBy: EmbeddingLedgerApprovedBy; why?: string };
}

export interface TierMoveDestination {
  corpusId: string;
  trustDomain: SourceTrustDomain;
  layers: TierCopyLayers;
  /** Whether the store's existing copy was only re-layered (no data written). */
  relayeredOnly: boolean;
  chunksWritten: number;
  chunksKept: number;
  vectorsCopied: number;
  /** Content chunks the destination still has to embed with its own model. */
  chunksToEmbed: number;
}

export interface TierMoveResult {
  outcome: 'moved' | 'secrets';
  raise: boolean;
  generation: number;
  destinations: TierMoveDestination[];
  /** Stores whose copy the flip superseded (kept, hidden). */
  supersededCorpora: string[];
  /** Chunks the move touched: written or kept at the destination, or tombstoned for Secrets. */
  chunkCount: number;
}

export async function moveTieredItem(options: TierMoveOptions): Promise<TierMoveResult> {
  const { set, identity, target } = options;
  const ledger = set.ledger;
  const record = ledger.getCurrent(identity);
  if (!record || !record.routed) throw new Error('Only a routed item can move; adopt a legacy placement first.');

  if (target.contentTier === 'secrets' || target.metadataTier === 'secrets') {
    return moveToSecrets(options, record.generation);
  }

  const placement = set.placementFor({
    metadataTier: target.metadataTier,
    contentTier: target.contentTier,
    state: 'current',
    metadataPending: false,
    contentPending: false,
  });
  const moveGeneration = record.generation + 1;
  const sources = ledger.copies(identity).filter((copy) => copy.state === 'current'
    || (copy.state === 'superseded' && copy.supersededByGeneration === moveGeneration));
  if (sources.length === 0) throw new Error('The item has no copy to move from.');
  const raise = placementIsRaise(sources, placement.copies);

  // 1. Stage (a raise hides the source first).
  ledger.stageMove(identity, {
    expectedGeneration: record.generation,
    target,
    destination: placement.copies,
    hideSource: raise,
  });

  // 2. Write what each destination lacks, from the source stores.
  const destinations: TierMoveDestination[] = [];
  const exports = new Map<string, ConnectorStoreItemCopy | undefined>();
  const exportFrom = (copy: TierCopy): ConnectorStoreItemCopy | undefined => {
    if (!exports.has(copy.corpusId)) {
      const domain = set.domainForCorpus(copy.corpusId);
      exports.set(copy.corpusId, domain ? set.store(domain)?.exportItemCopy(identity) : undefined);
    }
    return exports.get(copy.corpusId);
  };
  for (const planned of placement.copies) {
    const kept = sources.find((source) => source.corpusId === planned.corpusId);
    if (kept && layersCover(kept.layers, planned.layers)) {
      const keptChunks = planned.layers === 'metadata' ? 0 : (exportFrom(kept)?.chunks.length ?? 0);
      destinations.push({
        corpusId: planned.corpusId,
        trustDomain: planned.trustDomain,
        layers: planned.layers,
        relayeredOnly: true,
        chunksWritten: 0,
        chunksKept: keptChunks,
        vectorsCopied: 0,
        chunksToEmbed: 0,
      });
      continue;
    }
    const wantsContent = planned.layers !== 'metadata';
    const from = copyServingLayer(sources, wantsContent ? 'content' : 'metadata') ?? sources[0]!;
    const exported = exportFrom(from);
    if (!exported) throw new Error('The source store no longer holds an active copy of the item.');
    const payload: ConnectorStoreItemCopy = wantsContent
      ? exported
      : { ...exported, chunks: [], vectors: [], vectorAuthorities: [] };
    const store = set.store(planned.trustDomain, { create: true })!;
    const vectorIdentity = wantsContent ? options.vectorIdentities?.[planned.trustDomain] : undefined;
    const written = store.importItemCopy(payload, {
      trustTier: defaultStoreTrustTier(planned.trustDomain),
      syncConnectorId: TIER_MOVE_CONNECTOR_ID,
      layers: planned.layers,
      ...(vectorIdentity ? { vectorProvider: vectorIdentity } : {}),
    });
    destinations.push({
      corpusId: planned.corpusId,
      trustDomain: planned.trustDomain,
      layers: planned.layers,
      relayeredOnly: false,
      chunksWritten: written.chunksWritten,
      chunksKept: written.chunksKept,
      vectorsCopied: written.vectorsCopied,
      chunksToEmbed: wantsContent ? Math.max(0, payload.chunks.length - written.vectorsCopied) : 0,
    });
  }

  // 3. Flip.
  const flipped = ledger.completeMove(identity, {
    expectedGeneration: record.generation,
    destination: placement.copies,
  });
  const supersededCorpora = ledger.copies(identity)
    .filter((copy) => copy.state === 'superseded' && copy.supersededByGeneration === flipped.generation)
    .map((copy) => copy.corpusId);
  const chunkCount = destinations.reduce((total, destination) => total + destination.chunksWritten + destination.chunksKept, 0);

  if (options.embeddingLedger) {
    const vectorsCopied = destinations.reduce((total, destination) => total + destination.vectorsCopied, 0);
    const toEmbed = destinations.reduce((total, destination) => total + destination.chunksToEmbed, 0);
    await appendEmbeddingLedgerEntry(options.embeddingLedger.path, {
      recorded_at: new Date().toISOString(),
      kind: 'note',
      what: `Tier move of one item (${raise ? 'raise' : 'lateral or lower'}) from ${sources.map((copy) => copy.corpusId).join(', ')} `
        + `to ${destinations.map((destination) => `${destination.corpusId} (${destination.layers})`).join(', ')}: `
        + `${chunkCount} chunk(s) at the destination, ${vectorsCopied} vector(s) copied with no provider call, `
        + `${toEmbed} chunk(s) left for the destination's own embedding model. `
        + `Superseded copies are kept and hidden: ${supersededCorpora.join(', ') || 'none'}.`,
      scope: {
        corpora: [...new Set([...sources.map((copy) => copy.corpusId), ...destinations.map((destination) => destination.corpusId)])],
        chunks: Object.fromEntries(destinations.map((destination) => [
          destination.corpusId,
          destination.chunksWritten + destination.chunksKept,
        ])),
      },
      ...(options.embeddingLedger.why ? { why: options.embeddingLedger.why } : {}),
      approved_by: options.embeddingLedger.approvedBy,
      status: 'complete',
    });
  }

  return { outcome: 'moved', raise, generation: flipped.generation, destinations, supersededCorpora, chunkCount };
}

async function moveToSecrets(options: TierMoveOptions, expectedGeneration: number): Promise<TierMoveResult> {
  const { set, identity } = options;
  const ledger = set.ledger;
  const { record, copies } = ledger.flipToSecrets(identity, { expectedGeneration });
  let chunkCount = 0;
  const tombstoned: string[] = [];
  let located = false;
  for (const copy of copies) {
    const domain = set.domainForCorpus(copy.corpusId);
    const store = domain ? set.store(domain) : undefined;
    if (!store) continue;
    const exported = store.exportItemCopy(identity);
    chunkCount += exported?.chunks.length ?? 0;
    if (exported && !located) {
      // Location only: the kinds come from the detector, never the text.
      const text = exported.chunks.map((chunk) => chunk.boundedText).join('\n');
      const kinds = detectSecretFindingKinds(text);
      const locator = exported.columns.locator_uri;
      const title = exported.columns.title;
      set.secrets()?.record({
        identity,
        ...(typeof locator === 'string' ? { locator } : {}),
        ...(typeof title === 'string' ? { title } : {}),
        findingKinds: kinds.length > 0 ? kinds : ['owner_marked_secret'],
        text,
      });
      located = true;
    }
    store.tombstoneCopy(fullIdentity(identity), { connectorId: TIER_MOVE_CONNECTOR_ID, trustTier: 'S5' });
    tombstoned.push(copy.corpusId);
  }
  ledger.removeCopies(identity);
  if (options.embeddingLedger) {
    await appendEmbeddingLedgerEntry(options.embeddingLedger.path, {
      recorded_at: new Date().toISOString(),
      kind: 'invalidation',
      what: `One item became Secrets: its copies in ${tombstoned.join(', ') || 'no store'} were tombstoned and `
        + `${chunkCount} chunk(s) and their vectors deleted. Only its location is kept.`,
      scope: {
        corpora: tombstoned,
        chunks: Object.fromEntries(tombstoned.map((corpusId) => [corpusId, 0])),
      },
      ...(options.embeddingLedger.why ? { why: options.embeddingLedger.why } : {}),
      approved_by: options.embeddingLedger.approvedBy,
      status: 'complete',
    });
  }
  return {
    outcome: 'secrets',
    raise: true,
    generation: record.generation,
    destinations: [],
    supersededCorpora: tombstoned,
    chunkCount,
  };
}

function layersCover(held: TierCopyLayers, wanted: TierCopyLayers): boolean {
  return held === 'both' || held === wanted;
}

function fullIdentity(identity: TierMoveOptions['identity']): SourceItemIdentity {
  return {
    family: identity.family,
    provider: identity.provider,
    accountScope: identity.accountScope,
    providerItemId: identity.providerItemId,
    localItemId: identity.localItemId,
    ...(identity.providerConversationId ? { providerConversationId: identity.providerConversationId } : {}),
  };
}
