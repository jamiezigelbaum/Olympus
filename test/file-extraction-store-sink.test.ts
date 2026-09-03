// The extraction factory's store sink: extracted text becoming an enrichment
// of an item the shared connector store already holds.
//
// The parity of the sink's expectation with the store's own derivation is
// proved in file-extraction-store-sink-parity.test.ts. What this file covers is
// the sink's behaviour around that write: truthful counts, categorical skips
// instead of thrown errors, refusal of items the store may not hold text for,
// and — the trap that is easiest to miss — that the write ENRICHES the row
// rather than replacing it.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import {
  buildSourceSensitivity,
  type SourceSensitivity,
  type SourceTrustDomain,
  type SourceTrustTier,
} from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  connectorStoreChunkText,
  connectorStoreHashString,
  CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS,
} from '../src/workers/connector-store/index.ts';
import {
  EXTRACTION_SINK_SKIPPED_IDENTITY_AMBIGUOUS,
  EXTRACTION_SINK_SKIPPED_ITEM_MISSING,
  EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE,
  EXTRACTION_SINK_SKIPPED_OWNED_ELSEWHERE,
  createConnectorStoreExtractionSink,
  planExtractionSinkWrite,
} from '../src/workers/file-extraction/store-sink.ts';
import type { ExtractionItemRef, ExtractionSinkRequest } from '../src/workers/file-extraction/types.ts';

const CORPUS_ID = 'secure_local.fake.files';
const PROVIDER = 'fake';
const ACCOUNT = 'personal';
const ITEM_ID = 'item-1';
const SYNC_CONNECTOR_ID = 'extraction-factory-pass';
const OWNER_CONNECTOR_ID = 'family-connector';
const PROVIDER_DIGEST = 'provider-byte-digest-0001';

const SEEDED_TITLE = 'Quarterly Report.pdf';
const SEEDED_LOCATOR = '/Files/Quarterly Report.pdf';
const SEEDED_AUTHORED_AT = '2026-01-02T03:04:05.000Z';
const SEEDED_UPDATED_AT = '2026-02-03T04:05:06.000Z';
const SEEDED_SOURCE_VERSION = 'rev-7';

function seededItem(): RawItem {
  return {
    identity: {
      family: 'file',
      provider: PROVIDER,
      accountScope: ACCOUNT,
      providerItemId: ITEM_ID,
      localItemId: `local:${ITEM_ID}`,
      sourceVersion: SEEDED_SOURCE_VERSION,
    },
    mimeType: 'application/pdf',
    content: { kind: 'metadata_only' },
    metadata: {
      name: SEEDED_TITLE,
      pathDisplay: SEEDED_LOCATOR,
      contentHash: PROVIDER_DIGEST,
      authoredAt: SEEDED_AUTHORED_AT,
      updatedAt: SEEDED_UPDATED_AT,
    },
    fetchedAt: '2026-07-28T00:00:00.000Z',
  };
}

function createConnector(
  items: readonly RawItem[],
  sensitivity: SourceSensitivity,
): SourceConnector {
  return {
    id: 'fake-metadata-sync',
    family: 'file',
    async authenticate() {},
    async *listItems(_options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      yield { items, done: true };
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const found = items.find((item) => item.identity.localItemId === localItemId);
      if (!found) throw new Error(`no such item: ${localItemId}`);
      return found;
    },
    classify: () => sensitivity,
  };
}

async function seededStore(options: {
  trustDomain?: SourceTrustDomain;
  trustTier?: SourceTrustTier;
  items?: readonly RawItem[];
} = {}): Promise<LocalConnectorStore> {
  const trustDomain = options.trustDomain ?? 'secure_local';
  const store = new LocalConnectorStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'factory-sink-')), 'store.sqlite'),
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain,
  });
  await store.syncFromConnector(
    createConnector(
      options.items ?? [seededItem()],
      buildSourceSensitivity({ trustTier: options.trustTier ?? 'S2', trustDomain }),
    ),
    { fetchContent: false },
  );
  return store;
}

function refFor(overrides: Partial<ExtractionItemRef> = {}): ExtractionItemRef {
  return {
    corpusId: CORPUS_ID,
    provider: PROVIDER,
    accountScope: ACCOUNT,
    approvedScopeKey: 'scope-key',
    providerItemId: ITEM_ID,
    localItemId: `local:${ITEM_ID}`,
    sourceVersion: SEEDED_SOURCE_VERSION,
    contentHash: PROVIDER_DIGEST,
    name: SEEDED_TITLE,
    mimeType: 'application/pdf',
    ...overrides,
  };
}

function requestFor(text: string, overrides: Partial<ExtractionSinkRequest> = {}): ExtractionSinkRequest {
  return {
    ref: refFor(),
    text,
    extractorKind: 'fake-text',
    extractorVersion: '1',
    fetchedAt: '2026-07-28T01:00:00.000Z',
    ...overrides,
  };
}

function sinkFor(
  store: LocalConnectorStore,
  overrides: {
    trustTier?: SourceTrustTier;
    trustDomain?: SourceTrustDomain;
    skipOwner?: { connectorId: string; ownershipKind: 'observed' | 'preservation' };
  } = {},
) {
  return createConnectorStoreExtractionSink({
    store,
    classify: () => buildSourceSensitivity({
      trustTier: overrides.trustTier ?? 'S2',
      trustDomain: overrides.trustDomain ?? 'secure_local',
    }),
    syncConnectorId: SYNC_CONNECTOR_ID,
    ownerConnectorId: OWNER_CONNECTOR_ID,
    ownershipKind: 'observed',
    ...(overrides.skipOwner ? { skipOwner: overrides.skipOwner } : {}),
  });
}

describe('extraction factory store sink', () => {
  test('accepts text and reports chunk counts truthfully against a real store', async () => {
    const store = await seededStore();
    try {
      const text = 'w'.repeat(CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS + 200);
      const result = await sinkFor(store).accept(requestFor(text));
      expect(result.accepted).toBe(true);
      expect(result.skippedReason).toBeUndefined();
      expect(result.chunksIndexed).toBe(2);
      // Nothing was embedded: the sink attaches text and leaves the embed lane
      // to its own pass, so both chunks are still awaiting a vector.
      expect(result.chunksAwaitingEmbedding).toBe(2);
    } finally {
      store.close();
    }
  });

  test('a second identical accept still reports the chunks that are there', async () => {
    const store = await seededStore();
    try {
      const sink = sinkFor(store);
      const text = 'The extracted body of the report.';
      expect((await sink.accept(requestFor(text))).chunksIndexed).toBe(1);

      const second = await sink.accept(requestFor(text));
      expect(second.accepted).toBe(true);
      // The store short-circuits an unchanged item, so nothing was written and
      // nothing newly awaits embedding — but the chunk IS present, and saying
      // zero here would understate the representation the item actually has.
      expect(second.chunksIndexed).toBe(1);
      expect(second.chunksAwaitingEmbedding).toBe(0);
    } finally {
      store.close();
    }
  });

  test('the write ENRICHES the row instead of blanking what the metadata sync wrote', async () => {
    // The trap this sink exists to avoid. The store's upsert assigns the title,
    // locator, media type, timestamps and source version straight from the
    // emitted item, so a synthetic item built from the text alone would leave
    // citations with no title and no locator and ordering with no authored_at.
    const store = await seededStore();
    try {
      const text = 'The extracted body of the report.';
      await sinkFor(store).accept(requestFor(text));

      const candidate = store.extractionCandidates({ limit: 1 }).candidates[0]!;
      expect(candidate.name).toBe(SEEDED_TITLE);
      expect(candidate.locatorUri).toBe(SEEDED_LOCATOR);
      expect(candidate.mimeType).toBe('application/pdf');
      expect(candidate.identity.sourceVersion).toBe(SEEDED_SOURCE_VERSION);
      expect(candidate.storedChunks).toBe(1);

      const snapshot = store.itemMetadataSnapshot(candidate.identity)!;
      expect(snapshot.authoredAt).toBe(SEEDED_AUTHORED_AT);
      expect(snapshot.updatedAt).toBe(SEEDED_UPDATED_AT);
      // The stored content hash is now the hash of the extracted text, not the
      // provider's digest of the bytes.
      expect(snapshot.contentHash).toBe(connectorStoreHashString(text));
    } finally {
      store.close();
    }
  });

  test("a ref carrying no source version does not null the column the sync populated", async () => {
    const store = await seededStore();
    try {
      const text = 'Body text from a ref with no version marker.';
      const ref: ExtractionItemRef = { ...refFor() };
      delete ref.sourceVersion;
      const request = requestFor(text, { ref });
      const plan = planExtractionSinkWrite(store, request);
      expect('skippedReason' in plan).toBe(false);
      if ('skippedReason' in plan) throw new Error('unreachable');
      expect(plan.item.identity.sourceVersion).toBe(SEEDED_SOURCE_VERSION);
      expect(plan.expectation.sourceVersion).toBe(SEEDED_SOURCE_VERSION);

      await sinkFor(store).accept(request);
      expect(store.itemMetadataSnapshot(plan.item.identity)?.sourceVersion)
        .toBe(SEEDED_SOURCE_VERSION);
    } finally {
      store.close();
    }
  });

  test("the ref's provider digest never reaches the item, even via request metadata", async () => {
    const store = await seededStore();
    try {
      const text = 'Body text with a hostile metadata payload.';
      const plan = planExtractionSinkWrite(
        store,
        requestFor(text, { metadata: { contentHash: PROVIDER_DIGEST, extractorNote: 'kept' } }),
      );
      if ('skippedReason' in plan) throw new Error('unreachable');
      expect(plan.item.metadata['contentHash']).toBeUndefined();
      expect(plan.item.metadata['extractorNote']).toBe('kept');

      await sinkFor(store).accept(
        requestFor(text, { metadata: { contentHash: PROVIDER_DIGEST } }),
      );
      expect(store.itemMetadataSnapshot(plan.item.identity)?.contentHash)
        .toBe(connectorStoreHashString(text));

      // And the round trip settles rather than churning.
      const again = await sinkFor(store).accept(
        requestFor(text, { metadata: { contentHash: PROVIDER_DIGEST } }),
      );
      expect(again.accepted).toBe(true);
      expect(again.chunksAwaitingEmbedding).toBe(0);
    } finally {
      store.close();
    }
  });

  test('the expectation the sink builds is the one the store computes', async () => {
    const store = await seededStore();
    try {
      const text = '   Padded body text that the chunker will trim.   ';
      const plan = planExtractionSinkWrite(store, requestFor(text));
      if ('skippedReason' in plan) throw new Error('unreachable');
      expect(plan.expectation.contentHash).toBe(connectorStoreHashString(text));
      expect(plan.expectation.chunkContentHashes).toEqual(
        connectorStoreChunkText(text, CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS)
          .map(connectorStoreHashString),
      );
      expect(plan.expectation).not.toHaveProperty('embeddingInputHash');

      await sinkFor(store).accept(requestFor(text));
      expect(store.itemRepresentationCoverage(plan.expectation).complete).toBe(true);
    } finally {
      store.close();
    }
  });

  test('a missing item is a categorical skip, not a thrown error', async () => {
    const store = await seededStore();
    try {
      const result = await sinkFor(store).accept(
        requestFor('Text for an item nobody synced.', {
          ref: refFor({ providerItemId: 'never-synced', localItemId: 'local:never-synced' }),
        }),
      );
      expect(result).toEqual({
        accepted: false,
        chunksIndexed: 0,
        chunksAwaitingEmbedding: 0,
        skippedReason: EXTRACTION_SINK_SKIPPED_ITEM_MISSING,
      });
      // And nothing was created for it.
      expect(store.extractionCandidates({ limit: 10 }).candidates).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test('an S5 item is refused as a skip rather than escaping as an error', async () => {
    const store = await seededStore();
    try {
      const result = await sinkFor(store, { trustTier: 'S5' })
        .accept(requestFor('Text the store may not hold.'));
      expect(result.accepted).toBe(false);
      expect(result.skippedReason).toBe(EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE);
      expect(result.chunksIndexed).toBe(0);
      expect(store.extractionCandidates({ limit: 1 }).candidates[0]!.storedChunks).toBe(0);
    } finally {
      store.close();
    }
  });

  test('a trust-domain mismatch is refused as a skip', async () => {
    const store = await seededStore();
    try {
      const result = await sinkFor(store, { trustDomain: 'internal' })
        .accept(requestFor('Text classified into a different trust domain.'));
      expect(result.accepted).toBe(false);
      expect(result.skippedReason).toBe(EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE);
      expect(store.extractionCandidates({ limit: 1 }).candidates[0]!.storedChunks).toBe(0);
    } finally {
      store.close();
    }
  });

  test('skipOwner leaves an item alone and says so', async () => {
    const store = await seededStore();
    try {
      // The metadata sync claimed the item as an observed owner under its own
      // connector id; a sink told to skip that owner must not touch it.
      const result = await sinkFor(store, {
        skipOwner: { connectorId: 'fake-metadata-sync', ownershipKind: 'observed' },
      }).accept(requestFor('Text for an item another owner holds.'));
      expect(result.accepted).toBe(false);
      expect(result.skippedReason).toBe(EXTRACTION_SINK_SKIPPED_OWNED_ELSEWHERE);
      expect(store.extractionCandidates({ limit: 1 }).candidates[0]!.storedChunks).toBe(0);
    } finally {
      store.close();
    }
  });

  test('an item whose text is already stored is STILL refused once it is ineligible', async () => {
    // This is why eligibility is decided in the sink rather than by catching
    // the store's throw. The store short-circuits an item whose representation
    // is already complete BEFORE it classifies, so an item reclassified to S5
    // after its text landed would come back as a clean success if the sink
    // relied on the store to refuse it.
    const store = await seededStore();
    try {
      const text = 'Body text stored while the item was still eligible.';
      expect((await sinkFor(store).accept(requestFor(text))).accepted).toBe(true);

      const result = await sinkFor(store, { trustTier: 'S5' }).accept(requestFor(text));
      expect(result.accepted).toBe(false);
      expect(result.skippedReason).toBe(EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE);
    } finally {
      store.close();
    }
  });

  test('an identity matching more than one stored row is a skip, not a write', async () => {
    const scoped: RawItem = {
      ...seededItem(),
      identity: { ...seededItem().identity, providerConversationId: 'thread-a' },
    };
    const store = await seededStore({ items: [seededItem(), scoped] });
    try {
      const result = await sinkFor(store).accept(requestFor('Body text for an ambiguous identity.'));
      expect(result.accepted).toBe(false);
      expect(result.skippedReason).toBe(EXTRACTION_SINK_SKIPPED_IDENTITY_AMBIGUOUS);
      for (const candidate of store.extractionCandidates({ limit: 10 }).candidates) {
        expect(candidate.storedChunks).toBe(0);
      }
    } finally {
      store.close();
    }
  });

  test('an unexpected store failure is rethrown rather than disguised as a skip', async () => {
    // Deliberate: a mismatched family or an expectation that does not match its
    // item is a defect, and turning it into a categorical skip would leave the
    // lane reporting orderly progress while indexing nothing.
    const failing = {
      family: 'file',
      trustDomain: 'secure_local',
      itemMetadataSnapshot: () => ({ sourceVersion: SEEDED_SOURCE_VERSION }),
      restoreItemRepresentations: () => {
        throw new Error('Representation restore item family does not match the connector store.');
      },
    } as unknown as LocalConnectorStore;

    await expect(sinkFor(failing).accept(requestFor('Body text hitting a real defect.')))
      .rejects.toThrow('family does not match');
  });

  test('the sink does not embed', async () => {
    const store = await seededStore();
    try {
      await sinkFor(store).accept(requestFor('Body text that stays un-embedded.'));
      const counts = store.status().counts;
      // The chunk assertion keeps this honest: zero embedded chunks proves
      // nothing if no chunk was written in the first place.
      expect(counts.chunks).toBe(1);
      expect(counts.embeddedChunks).toBe(0);
    } finally {
      store.close();
    }
  });
});
