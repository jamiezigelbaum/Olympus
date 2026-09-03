/**
 * Seam 3 of the extraction factory: where extracted text lands.
 *
 * This module is enrolled in the architecture guard's source-agnostic list, so
 * it may not name a concrete source family. Providers, account scopes and
 * corpus ids arrive as DATA on the request. Doc comments here are always
 * multi-line blocks: the guard's regex-literal heuristic reads a one-line
 * block comment as a regex literal.
 *
 * The sink ENRICHES an item that already exists in the shared store. It never
 * creates one, never embeds, and never writes empty text. The ordering it
 * depends on is metadata sync, then extraction, then embedding.
 *
 * Two agreements make this work, and both are easy to break silently:
 *
 *   1. The representation expectation must predict exactly what the store will
 *      derive. One string feeds the item content, the content hash and the
 *      chunker, and the chunking runs the store's own exported recipe rather
 *      than a copy of it. A mismatch of one character means coverage never
 *      reports complete and every pass re-restores every item forever.
 *   2. The synthetic item must be COMPLETE, not a stub. The store's upsert
 *      assigns the title, locator, media type, both timestamps and the source
 *      version straight from the emitted item, so an item built from the text
 *      alone blanks everything the metadata sync wrote. The stored row is read
 *      back and folded in before the write.
 */

import type { RawItem } from '../../core/contracts.ts';
import type {
  SourceItemIdentity,
  SourceSensitivity,
} from '../../core/source-index/types.ts';
import {
  CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS,
  connectorStoreChunkText,
  connectorStoreHashString,
  type ConnectorStoreItemMetadataSnapshot,
  type ConnectorStoreItemRepresentationExpectation,
  type ConnectorStoreOwnershipKind,
  type LocalConnectorStore,
} from '../connector-store/index.ts';
import type {
  ExtractionClaimReader,
  ExtractionItemRef,
  ExtractionSink,
  ExtractionSinkRequest,
  ExtractionSinkResult,
} from './types.ts';

/**
 * Categorical skip tokens. The sink answers with one of these instead of
 * throwing, so a runner can settle the job without parsing an error string.
 */
export const EXTRACTION_SINK_SKIPPED_ITEM_MISSING = 'store_item_missing';
export const EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE = 'store_item_not_eligible';
export const EXTRACTION_SINK_SKIPPED_OWNED_ELSEWHERE = 'store_item_owned_elsewhere';
export const EXTRACTION_SINK_SKIPPED_EMPTY_TEXT = 'extracted_text_empty';
export const EXTRACTION_SINK_SKIPPED_IDENTITY_AMBIGUOUS = 'store_identity_ambiguous';
/**
 * The item is indexed and the owner's configuration says its content is never
 * read. The extraction ran anyway — a job outlives a configuration change —
 * and the store refused the write, which is the correct outcome and not a
 * failure. Reported as its own token so the runner settles the job as
 * metadata-only instead of retrying an extraction that can never land.
 */
export const EXTRACTION_SINK_SKIPPED_METADATA_ONLY = 'store_item_metadata_only';
/**
 * Somebody else holds this job now. Unlike every other token here this one is
 * NOT a settled outcome: the work is still owed, the current holder is doing
 * it, and this worker's only correct move is to drop its text and let the job
 * store refuse its record. The runner settles it retryable as a lost lease,
 * which is why this token is deliberately absent from the runner's skip table.
 */
export const EXTRACTION_SINK_SKIPPED_CLAIM_SUPERSEDED = 'extraction_claim_superseded';

/**
 * Maps the two store refusals a healthy sink can race into onto skip tokens,
 * and returns undefined for everything else so the caller rethrows.
 *
 * Matching on the message is not lovely, but the store signals these with
 * plain Errors and the alternative — treating every failure as a skip — is the
 * one that hides real defects. Only the token crosses the boundary; the
 * message itself never does.
 */
function racedRestoreSkipReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('targeted store item is missing')) {
    return EXTRACTION_SINK_SKIPPED_ITEM_MISSING;
  }
  if (message.includes('matches multiple store rows')) {
    return EXTRACTION_SINK_SKIPPED_IDENTITY_AMBIGUOUS;
  }
  return undefined;
}

export interface ConnectorStoreExtractionSinkOptions {
  store: LocalConnectorStore;
  /**
   * Trust classification for the synthetic item. The store refuses S5 and any
   * trust domain other than its own; the sink reports that refusal as a skip
   * rather than letting it escape as an error.
   */
  classify: (item: RawItem) => SourceSensitivity;
  /**
   * Who is running this pass. Recorded on the sync-run row.
   */
  syncConnectorId: string;
  /**
   * Who owns the item. Written to the ownership table.
   */
  ownerConnectorId: string;
  ownershipKind: ConnectorStoreOwnershipKind;
  /**
   * Optional: leave an item alone when a specific owner already claims it.
   */
  skipOwner?: {
    connectorId: string;
    ownershipKind: ConnectorStoreOwnershipKind;
  };
  /**
   * The current-grant oracle for the lease fence, consulted immediately before
   * the representation write when the request carries a claim.
   *
   * Optional so every sink built without a queue behind it — the tests, any
   * future caller that is not the extraction runner — keeps working unchanged.
   * Where it IS wired, it is the only thing standing between a superseded
   * worker and the current holder's content.
   */
  claims?: ExtractionClaimReader;
}

/**
 * The sink's view of one accepted extraction, exported so a runner can build
 * and inspect the expectation without reaching into the store.
 */
export interface ExtractionSinkPlan {
  item: RawItem;
  expectation: ConnectorStoreItemRepresentationExpectation;
}

/**
 * Builds the identity the store will be asked to enrich.
 *
 * The family is read off the store rather than carried on the ref: the store
 * throws when the two disagree, and reading it here is what keeps every
 * factory type family-free.
 *
 * The ref carries no conversation id, so this targets the conversation-
 * unscoped row for the identity. An item filed under a conversation is a
 * different row and this sink cannot reach it.
 */
function identityForRef(
  store: LocalConnectorStore,
  ref: ExtractionItemRef,
  sourceVersion: string | undefined,
): SourceItemIdentity {
  return {
    family: store.family,
    provider: ref.provider,
    accountScope: ref.accountScope,
    providerItemId: ref.providerItemId,
    localItemId: ref.localItemId,
    ...(sourceVersion ? { sourceVersion } : {}),
  };
}

/**
 * The expectation formula, in one place.
 *
 * `contentHash` hashes the text as given; `chunkContentHashes` hash the store's
 * chunks, which come from the TRIMMED text. That asymmetry is safe only because
 * a single string is used for the item content, the hash and the chunker, which
 * is why the text is taken from one variable and never re-derived.
 */
export function buildExtractionRepresentationExpectation(
  identity: SourceItemIdentity,
  text: string,
): ConnectorStoreItemRepresentationExpectation {
  return {
    sourceItem: identity,
    ...(identity.sourceVersion ? { sourceVersion: identity.sourceVersion } : {}),
    contentHash: connectorStoreHashString(text),
    chunkContentHashes: connectorStoreChunkText(
      text,
      CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS,
    ).map(connectorStoreHashString),
  };
}

/**
 * Metadata for the synthetic item.
 *
 * The stored row supplies the base so the write cannot blank it; the request's
 * own metadata is layered on top; and `contentHash` is stripped from BOTH,
 * unconditionally and last.
 *
 * That strip is the load-bearing line. The ref's content hash is the provider's
 * digest of the bytes, an unrelated value to the hash of the extracted text. If
 * it reached the item, the store would write it into the item's content hash
 * column while the expectation predicted the hash of the text, the two would
 * never meet, and the item would be re-restored on every pass forever.
 */
function metadataForItem(
  stored: ConnectorStoreItemMetadataSnapshot,
  ref: ExtractionItemRef,
  requested: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const name = ref.name ?? stored.name;
  const merged: Record<string, unknown> = {
    ...(name ? { name } : {}),
    ...(stored.locatorUri ? { locatorUri: stored.locatorUri } : {}),
    ...(stored.authoredAt ? { authoredAt: stored.authoredAt } : {}),
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
    ...(requested ?? {}),
  };
  delete merged['contentHash'];
  return merged;
}

/**
 * The only sanctioned way to attach extracted text to an item in the shared
 * store.
 *
 * `syncConnectorId` and `ownerConnectorId` are both required rather than one
 * being derived from the other. They record different facts — who ran the pass
 * versus who owns the item — and the factory is never the owner of an item it
 * merely enriched. Collapsing them would either mislabel the audit trail or
 * write the factory into the ownership table, where it would then satisfy
 * other passes' owner checks.
 */
export function createConnectorStoreExtractionSink(
  options: ConnectorStoreExtractionSinkOptions,
): ExtractionSink {
  const store = options.store;

  return {
    async accept(request: ExtractionSinkRequest): Promise<ExtractionSinkResult> {
      const plan = planExtractionSinkWrite(store, request);
      if ('skippedReason' in plan) {
        return {
          accepted: false,
          chunksIndexed: 0,
          chunksAwaitingEmbedding: 0,
          skippedReason: plan.skippedReason,
        };
      }

      // Eligibility is decided HERE rather than by catching the store's throw.
      // The store checks the same two conditions itself, but only on the path
      // where it actually writes: an item whose representation is already
      // complete short-circuits before classification, so relying on the throw
      // would let an ineligible item report success purely because a previous
      // pass had already stored its text.
      const sensitivity = options.classify(plan.item);
      if (sensitivity.trustDomain !== store.trustDomain || sensitivity.trustTier === 'S5') {
        return {
          accepted: false,
          chunksIndexed: 0,
          chunksAwaitingEmbedding: 0,
          skippedReason: EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE,
        };
      }

      // THE CHEAP HALF OF THE LEASE FENCE, and it belongs exactly here: the
      // last statement before the only irreversible thing this function does.
      //
      // The runner's pre-extraction check reads a lease expiry cached at claim
      // time, which cannot see a recycle that reclaimed a still-unexpired lease
      // (`staleOnly: false`, what a paused backend uses) — so a superseded
      // worker sailed through it, wrote here, and only then had its record()
      // refused. The job database said the new holder won while the corpus held
      // the stale worker's text, and a differing expectation means the write
      // genuinely replaced the newer content rather than colliding with it.
      //
      // This probe reads the OTHER database, so on its own it can only report
      // the past: a recycle landing between it and the write below was enough
      // to overwrite the new holder's content. It stays because it is the early
      // exit that keeps a superseded worker from doing pointless work, but the
      // decision that actually holds is the grant carried into the write and
      // compared inside the store's own transaction.
      if (request.claim && options.claims && !options.claims.holdsExtractionClaim(request.claim)) {
        return {
          accepted: false,
          chunksIndexed: 0,
          chunksAwaitingEmbedding: 0,
          skippedReason: EXTRACTION_SINK_SKIPPED_CLAIM_SUPERSEDED,
        };
      }

      let summary;
      try {
        summary = store.restoreItemRepresentations({
          items: [{ item: plan.item, expectation: plan.expectation }],
          syncConnectorId: options.syncConnectorId,
          ownerConnectorId: options.ownerConnectorId,
          ownershipKind: options.ownershipKind,
          classify: options.classify,
          ...(options.skipOwner ? { skipOwner: options.skipOwner } : {}),
          // THE DECIDING HALF. The grant travels into the store's write
          // transaction, where it is compared against the newest one that
          // corpus has accepted for this item and extractor — a comparison no
          // race can get between, because it commits with the content itself.
          //
          // Scoped by extractor kind, so two extractors reading the same item
          // order their own generations without ordering each other's. The
          // lease token is hashed rather than copied: it is a capability in the
          // queue, and the corpus needs only to tell two generations apart.
          ...(request.claim
            ? {
              writeClaim: {
                scope: request.extractorKind,
                authority: request.claim.grantAuthority,
                ordinal: request.claim.grantOrdinal,
                holder: request.claim.jobId,
                generation: connectorStoreHashString(request.claim.leaseToken),
              },
            }
            : {}),
        });
      } catch (error) {
        // Only the two refusals a healthy sink can genuinely race into become
        // skips: the row disappearing between the presence probe above and this
        // write, and an identity that turns out to match more than one row.
        //
        // Everything else is rethrown ON PURPOSE. A mismatched family, an
        // expectation that does not match its item, a duplicate identity in the
        // batch — those are programming errors, and swallowing them into a
        // categorical skip would leave the lane reporting orderly progress
        // while indexing nothing at all.
        const skippedReason = racedRestoreSkipReason(error);
        if (skippedReason === undefined) throw error;
        return { accepted: false, chunksIndexed: 0, chunksAwaitingEmbedding: 0, skippedReason };
      }

      // A row removed between the presence probe and this write is the same
      // answer as one that was never there: nothing to attach content to. It
      // arrives as a counted skip rather than a throw because the store must
      // not resurrect it, and the batch around it is otherwise healthy.
      if (summary.counts.itemsSkippedTombstoned === 1) {
        return {
          accepted: false,
          chunksIndexed: 0,
          chunksAwaitingEmbedding: 0,
          skippedReason: EXTRACTION_SINK_SKIPPED_ITEM_MISSING,
        };
      }

      // The store refused this generation: a newer one already wrote here. It
      // is the same answer as the probe above, reached the only way that is
      // race-free, so it settles the same way — the work is owed, the current
      // holder is doing it, and this worker drops its text.
      if (summary.counts.itemsSkippedStaleClaim === 1) {
        return {
          accepted: false,
          chunksIndexed: 0,
          chunksAwaitingEmbedding: 0,
          skippedReason: EXTRACTION_SINK_SKIPPED_CLAIM_SUPERSEDED,
        };
      }

      if (summary.counts.itemsSkippedByOwner === 1) {
        return {
          accepted: false,
          chunksIndexed: 0,
          chunksAwaitingEmbedding: 0,
          skippedReason: EXTRACTION_SINK_SKIPPED_OWNED_ELSEWHERE,
        };
      }

      // Checked BEFORE the coverage read below, because that read would report
      // zero chunks alongside `accepted: true` — a lane making no progress
      // while reporting success, which is the shape this file's whole comment
      // budget exists to prevent.
      if (summary.counts.itemsMetadataOnly === 1) {
        return {
          accepted: false,
          chunksIndexed: 0,
          chunksAwaitingEmbedding: 0,
          skippedReason: EXTRACTION_SINK_SKIPPED_METADATA_ONLY,
        };
      }

      // Truthful counts, read back from the store rather than assumed: an
      // unchanged item wrote nothing this pass but still holds the chunks the
      // expectation describes, and reporting zero for it would understate the
      // representation that is actually there.
      const coverage = store.itemRepresentationCoverage(plan.expectation);
      return {
        accepted: true,
        chunksIndexed: coverage.chunksIndexed,
        chunksAwaitingEmbedding: summary.counts.chunksAwaitingEmbedding,
      };
    },
  };
}

/**
 * Everything the sink decides before it writes: the identity to target, the
 * complete synthetic item, and the expectation. Exported so a runner or a test
 * can inspect the write without performing it.
 */
export function planExtractionSinkWrite(
  store: LocalConnectorStore,
  request: ExtractionSinkRequest,
): ExtractionSinkPlan | { skippedReason: string } {
  const text = request.text;
  // Defence in depth. The landed types already make an empty result
  // unrepresentable as a request, because only an indexed extractor output
  // carries text at all. This guard exists because the store reads empty text
  // as "delete this item's representation", so the cost of the type invariant
  // being wrong once is destroyed data rather than a bad write.
  if (text.trim() === '') return { skippedReason: EXTRACTION_SINK_SKIPPED_EMPTY_TEXT };

  const ref = request.ref;
  const identityResolver = (
    store as LocalConnectorStore & {
      activeIdentityForLocalItemId?: LocalConnectorStore['activeIdentityForLocalItemId'];
    }
  ).activeIdentityForLocalItemId;
  const storedIdentity = identityResolver?.call(store, {
    provider: ref.provider,
    accountScope: ref.accountScope,
    providerItemId: ref.providerItemId,
    localItemId: ref.localItemId,
  });
  const probe = storedIdentity ?? identityForRef(store, ref, ref.sourceVersion);
  const stored = store.itemMetadataSnapshot(probe);
  if (!stored) return { skippedReason: EXTRACTION_SINK_SKIPPED_ITEM_MISSING };

  // A ref with no source version must not null the column the metadata sync
  // populated: the store compares that column against the expectation, so
  // erasing it here would degrade a later currency check into a no-op.
  const identity = {
    ...probe,
    ...((ref.sourceVersion ?? stored.sourceVersion)
      ? { sourceVersion: ref.sourceVersion ?? stored.sourceVersion }
      : {}),
  };

  return {
    item: {
      identity,
      // `ref.mimeType` must be the SOURCE media type, never the type of the
      // text the extractor produced. It is written straight to the item's
      // stored media type, which is the spine's only durable signal for what
      // kind of thing this item is and which extractor should read it next;
      // putting a text type there would make a document look already-plain and
      // quietly remove it from future extraction passes.
      mimeType: ref.mimeType ?? stored.mimeType ?? 'application/octet-stream',
      content: { kind: 'text', text },
      metadata: metadataForItem(stored, ref, request.metadata),
      fetchedAt: request.fetchedAt,
    },
    expectation: buildExtractionRepresentationExpectation(identity, text),
  };
}
