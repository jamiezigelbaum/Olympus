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
import type { TierDecision, TierKey } from '../classification/tier-classifier.ts';
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
import { settleSecretsCopies, type SecretsDisposition } from './secrets-disposition.ts';
import { defaultStoreTrustTier } from './tier-placement.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

export const TIER_MOVE_CONNECTOR_ID = 'olympus_tier_move';

/** A move the primitive refuses before writing anything (the item stays where it is). */
export class TierMoveRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TierMoveRefusedError';
  }
}

export type TierMoveEmbeddingIdentity = Pick<
  SourceEmbeddingProvider,
  'modelId' | 'provider' | 'backend' | 'dimension' | 'epochId' | 'configHash'
>;

export interface TierMoveOptions {
  set: TieredStoreSet;
  identity: Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId' | 'providerConversationId' | 'family' | 'localItemId'>;
  /** The tiers to move to. Required unless `decision` is given. */
  target?: { metadataTier: TierKey; contentTier: TierKey };
  /**
   * The full classifier decision the move carries out (the migration's). Its
   * tiers are the target; the placement is exactly what a sync would compute
   * for it (`placementFor`, open questions included); and its flags and
   * reason codes are recorded at the flip, in the same write.
   */
  decision?: TierDecision;
  /**
   * Each destination store's canonical embedding identity. Vectors are copied
   * only into a store whose identity is given here and matches the vectors'.
   */
  vectorIdentities?: Partial<Record<SourceTrustDomain, TierMoveEmbeddingIdentity>>;
  /** Overrides the Secrets policy (secrets-disposition.ts); tests only. */
  secretsDisposition?: SecretsDisposition;
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
  /** Secrets only: chunks per corpus deleted (tombstone_now) or kept hidden (hide_until_purge). */
  secretsChunks?: Record<string, number>;
  secretsDisposition?: SecretsDisposition;
}

export async function moveTieredItem(options: TierMoveOptions): Promise<TierMoveResult> {
  const { set, identity, decision } = options;
  const target = decision
    ? { metadataTier: decision.metadataTier, contentTier: decision.contentTier }
    : options.target;
  if (!target) throw new Error('A tier move needs target tiers or a decision.');
  const ledger = set.ledger;
  const record = ledger.getCurrent(identity);
  if (!record || !record.routed) throw new Error('Only a routed item can move; adopt a legacy placement first.');

  if (target.contentTier === 'secrets' || target.metadataTier === 'secrets') {
    return moveToSecrets(options, record.generation);
  }

  // Without a decision the move keeps what the ledger knows about the text:
  // a lane whose content arrives later places an item whose text was never
  // read by its names only, so a move must not forget text that was read.
  const placement = set.placementFor(decision ?? {
    metadataTier: target.metadataTier,
    contentTier: target.contentTier,
    state: 'current',
    metadataPending: false,
    contentPending: false,
    contentRead: record.contentRead,
  });
  const moveGeneration = record.generation + 1;
  const sources = ledger.copies(identity).filter((copy) => copy.state === 'current'
    || (copy.state === 'superseded' && copy.supersededByGeneration === moveGeneration));
  if (sources.length === 0) throw new Error('The item has no copy to move from.');
  const raise = placementIsRaise(sources, placement.copies);
  // Staging a destination rewrites that store's row. A copy kept there as
  // superseded (an earlier move's) would be lost before any approved purge:
  // refuse instead, and leave the item where it is.
  const kept = ledger.copies(identity);
  for (const planned of placement.copies) {
    if (sources.some((source) => source.corpusId === planned.corpusId)) continue;
    if (kept.some((copy) => copy.corpusId === planned.corpusId && copy.state === 'superseded')) {
      throw new TierMoveRefusedError('The destination store keeps a superseded copy of this item; purge it (owner-approved) before moving there.');
    }
  }

  // 1. Stage (a raise hides the source first).
  ledger.stageMove(identity, {
    expectedGeneration: record.generation,
    target,
    destination: placement.copies,
    hideSource: raise,
    ...(placement.embedHold ? { embedHold: true } : {}),
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
    store.bindTierSet(ledger);
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
    ...(decision ? { decidedBy: decision.decidedBy, reasons: decision.reasons, decision } : {}),
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
  // One write hides every copy; what happens to them next is the Secrets
  // policy's (secrets-disposition.ts), decided in one place.
  const { record, copies } = ledger.flipToSecrets(identity, { expectedGeneration });
  let located = false;
  for (const copy of copies) {
    if (located) break;
    const domain = set.domainForCorpus(copy.corpusId);
    const exported = domain ? set.store(domain)?.exportItemCopy(identity) : undefined;
    if (!exported) continue;
    // Location only: the kinds come from the detector, never the text.
    const text = exported.chunks.map((chunk) => chunk.boundedText).join('\n');
    const kinds = detectSecretFindingKinds(text);
    const locator = exported.columns.locator_uri;
    const title = exported.columns.title;
    set.secrets()?.record({
      identity,
      // The names' tier before the item became Secrets decides whether its
      // title may be released.
      namesReleasable: record.previousMetadataTier === 'public' || record.previousMetadataTier === 'private',
      ...(typeof locator === 'string' ? { locator } : {}),
      ...(typeof title === 'string' ? { title } : {}),
      findingKinds: kinds.length > 0 ? kinds : ['owner_marked_secret'],
      text,
    });
    located = true;
  }
  const settled = settleSecretsCopies({
    ledger,
    identity: fullIdentity(identity),
    copies,
    storeFor: (corpusId) => {
      const domain = set.domainForCorpus(corpusId);
      return domain ? set.store(domain) : undefined;
    },
    connectorId: TIER_MOVE_CONNECTOR_ID,
    ...(options.secretsDisposition ? { disposition: options.secretsDisposition } : {}),
  });
  const corpora = Object.keys(settled.chunks);
  const chunkCount = Object.values(settled.chunks).reduce((sum, count) => sum + count, 0);
  if (options.embeddingLedger) {
    const deleted = settled.disposition === 'tombstone_now';
    await appendEmbeddingLedgerEntry(options.embeddingLedger.path, {
      recorded_at: new Date().toISOString(),
      kind: deleted ? 'invalidation' : 'note',
      what: deleted
        ? `One item became Secrets: its copies in ${corpora.join(', ') || 'no store'} were tombstoned and `
          + `${chunkCount} chunk(s) and their vectors deleted. Only its location is kept.`
        : `One item became Secrets: its copies in ${corpora.join(', ') || 'no store'} (${chunkCount} chunk(s)) `
          + 'are hidden and kept until an owner-approved purge. Only its location is served.',
      scope: { corpora, chunks: settled.chunks },
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
    supersededCorpora: corpora,
    chunkCount,
    secretsChunks: settled.chunks,
    secretsDisposition: settled.disposition,
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
