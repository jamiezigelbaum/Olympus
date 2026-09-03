// Chunk-hash parity between the extraction factory's representation
// expectation and what the connector store actually stores.
//
// This is the one seam of the extraction factory that could not be verified by
// reading the store: the factory predicts a content hash and a list of chunk
// content hashes, hands them to restoreItemRepresentations as an expectation,
// and the store independently derives the same values from the RawItem it is
// given. If the two derivations disagree by even one character of input, the
// store's coverage short-circuit never reports `complete` and every pass
// re-restores every item forever — permanent churn behind a coverage signal
// that is always wrong.
//
// The proof is a double restore. The first call writes; a second identical
// call must report itemsUnchanged: 1 and itemsRestored: 0. That round trip
// exercises the whole agreement at once: the derived items.content_hash, the
// chunk hashes, the FTS row count and the trim asymmetry between them.
//
// The negative controls at the bottom matter as much as the positive ones. A
// parity test that cannot fail proves nothing, so each way the expectation can
// be built wrong is asserted to break the round trip.

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
  type SourceItemIdentity,
} from '../src/core/source-index/types.ts';
import {
  CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS,
  LocalConnectorStore,
  connectorStoreChunkText,
  connectorStoreHashString,
  type ConnectorStoreItemRepresentationExpectation,
} from '../src/workers/connector-store/index.ts';

const CORPUS_ID = 'secure_local.fake.files';
const PROVIDER = 'fake';
const ACCOUNT = 'personal';
const SYNC_CONNECTOR_ID = 'fake-extraction-sink';
const OWNER_CONNECTOR_ID = 'fake-extraction-owner';

// The provider's own digest of the bytes. Deliberately NOT a hash of the
// extracted text: the whole point of the trap tests below is that these two
// values are unrelated and must never be confused for one another.
const PROVIDER_DIGEST = 'rev-digest-0001';

function identityFor(itemId: string, sourceVersion?: string): SourceItemIdentity {
  return {
    family: 'file',
    provider: PROVIDER,
    accountScope: ACCOUNT,
    providerItemId: itemId,
    localItemId: `local:${itemId}`,
    ...(sourceVersion ? { sourceVersion } : {}),
  };
}

// The metadata-sync view of the item: no text at all, and carrying the
// provider's digest in metadata.contentHash exactly as a real connector would.
// That digest lands in items.content_hash, which is what makes the first
// restore a genuine change rather than a no-op.
function metadataOnlyItem(itemId: string, sourceVersion?: string): RawItem {
  return {
    identity: identityFor(itemId, sourceVersion),
    mimeType: 'application/pdf',
    content: { kind: 'metadata_only' },
    metadata: {
      name: `${itemId}.pdf`,
      contentHash: PROVIDER_DIGEST,
      pathDisplay: `/Files/${itemId}.pdf`,
    },
    fetchedAt: '2026-07-28T00:00:00.000Z',
  };
}

// The synthetic item the sink will build once extraction has produced text.
//
// `metadataContentHash` is a knob for the trap test only. In the shipping
// shape it is left undefined, so the store derives items.content_hash as
// hashString(content.text) and the expectation below agrees with it.
function extractedTextItem(
  itemId: string,
  text: string,
  options: { sourceVersion?: string; metadataContentHash?: string } = {},
): RawItem {
  return {
    identity: identityFor(itemId, options.sourceVersion),
    mimeType: 'application/pdf',
    content: { kind: 'text', text },
    metadata: {
      name: `${itemId}.pdf`,
      pathDisplay: `/Files/${itemId}.pdf`,
      ...(options.metadataContentHash ? { contentHash: options.metadataContentHash } : {}),
    },
    fetchedAt: '2026-07-28T01:00:00.000Z',
  };
}

// The expectation formula under test. One string — `text` — feeds the item
// content, the content hash and the chunker, and the chunk size is the store's
// own default rather than a number repeated by hand.
function expectationFor(
  item: RawItem,
  text: string,
): ConnectorStoreItemRepresentationExpectation {
  return {
    sourceItem: item.identity,
    ...(item.identity.sourceVersion ? { sourceVersion: item.identity.sourceVersion } : {}),
    contentHash: connectorStoreHashString(text),
    chunkContentHashes: connectorStoreChunkText(
      text,
      CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS,
    ).map(connectorStoreHashString),
  };
}

function createMetadataConnector(items: readonly RawItem[]): SourceConnector {
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
    classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
  };
}

function newStore(dbPath: string): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath,
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
}

function tempDbPath(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `factory-sink-${label}-`)), 'store.sqlite');
}

function restore(
  store: LocalConnectorStore,
  item: RawItem,
  expectation: ConnectorStoreItemRepresentationExpectation,
) {
  return store.restoreItemRepresentations({
    items: [{ item, expectation }],
    syncConnectorId: SYNC_CONNECTOR_ID,
    ownerConnectorId: OWNER_CONNECTOR_ID,
    ownershipKind: 'observed',
    classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
  });
}

// Sync one metadata-only row in, then run the given text through a restore
// twice, returning both summaries plus the store for further assertions.
async function seedAndRestoreTwice(options: {
  label: string;
  itemId: string;
  text: string;
  sourceVersion?: string;
  metadataContentHash?: string;
  perturb?: (
    expectation: ConnectorStoreItemRepresentationExpectation,
  ) => ConnectorStoreItemRepresentationExpectation;
}) {
  const store = newStore(tempDbPath(options.label));
  const seeded = metadataOnlyItem(options.itemId, options.sourceVersion);
  await store.syncFromConnector(createMetadataConnector([seeded]), { fetchContent: false });

  const item = extractedTextItem(options.itemId, options.text, {
    ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
    ...(options.metadataContentHash ? { metadataContentHash: options.metadataContentHash } : {}),
  });
  const base = expectationFor(item, options.text);
  const expectation = options.perturb ? options.perturb(base) : base;

  const first = restore(store, item, expectation);
  const second = restore(store, item, expectation);
  return { store, item, expectation, first, second };
}

describe('extraction factory store sink: chunk-hash parity with the connector store', () => {
  test('the metadata-only seed really does start with the provider digest as its content hash', async () => {
    // Guards the premise of every test below. If the seed already agreed with
    // the expectation, the first restore would be a no-op and the double
    // restore would prove nothing.
    const store = newStore(tempDbPath('premise'));
    try {
      const seeded = metadataOnlyItem('premise-1');
      await store.syncFromConnector(createMetadataConnector([seeded]), { fetchContent: false });
      expect(store.itemPresence(seeded.identity)).toEqual({
        active: true,
        contentHash: PROVIDER_DIGEST,
      });
    } finally {
      store.close();
    }
  });

  test('a single-chunk restore is idempotent: the second identical pass reports unchanged', async () => {
    const text = 'The quarterly report body, extracted from a PDF.';
    const { store, first, second, expectation } = await seedAndRestoreTwice({
      label: 'single',
      itemId: 'single-1',
      text,
      sourceVersion: 'rev-1',
    });
    try {
      expect(expectation.chunkContentHashes).toHaveLength(1);
      expect(first.counts.itemsRestored).toBe(1);
      expect(first.counts.itemsUnchanged).toBe(0);

      // The parity assertion.
      expect(second.counts.itemsRestored).toBe(0);
      expect(second.counts.itemsUnchanged).toBe(1);

      // And the store agrees when asked directly, not only via the restore.
      const coverage = store.itemRepresentationCoverage(expectation);
      expect(coverage.complete).toBe(true);
      expect(coverage.chunksIndexed).toBe(1);
    } finally {
      store.close();
    }
  });

  test('the restore replaces the provider digest with the hash of the extracted text', async () => {
    // The trap, stated as an assertion rather than a comment: items.content_hash
    // is derived by the store and must end up equal to hashString(text), not to
    // the provider's digest of the bytes.
    const text = 'Extracted text whose hash becomes the stored content hash.';
    const { store, item } = await seedAndRestoreTwice({
      label: 'derived-hash',
      itemId: 'derived-1',
      text,
    });
    try {
      const presence = store.itemPresence(item.identity);
      expect(presence.contentHash).toBe(connectorStoreHashString(text));
      expect(presence.contentHash).not.toBe(PROVIDER_DIGEST);
    } finally {
      store.close();
    }
  });

  test('a multi-chunk item round-trips: chunk boundaries agree with the store', async () => {
    // Three chunks at the store's 4,000-character default, with the last one
    // deliberately short so an off-by-one in the final slice would show up.
    const text = 'x'.repeat(CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS * 2 + 1_500);
    const { store, first, second, expectation } = await seedAndRestoreTwice({
      label: 'multi',
      itemId: 'multi-1',
      text,
      sourceVersion: 'rev-9',
    });
    try {
      expect(expectation.chunkContentHashes).toHaveLength(3);
      expect(first.counts.itemsRestored).toBe(1);
      expect(second.counts.itemsUnchanged).toBe(1);
      expect(store.itemRepresentationCoverage(expectation).chunksIndexed).toBe(3);
    } finally {
      store.close();
    }
  });

  test('leading and trailing whitespace survives the trim asymmetry', async () => {
    // chunkText trims before slicing while the content hash is taken over the
    // untrimmed string. That is consistent only because ONE string feeds the
    // item content, the content hash and the chunker. This test is what fails
    // if a future change trims in one of those places and not the others.
    const text = '\n\n   Extracted body with padding around it.   \n\t\n';
    const { store, first, second, expectation } = await seedAndRestoreTwice({
      label: 'whitespace',
      itemId: 'whitespace-1',
      text,
    });
    try {
      expect(expectation.contentHash).toBe(connectorStoreHashString(text));
      expect(expectation.contentHash).not.toBe(connectorStoreHashString(text.trim()));
      expect(expectation.chunkContentHashes).toEqual([connectorStoreHashString(text.trim())]);
      expect(first.counts.itemsRestored).toBe(1);
      expect(second.counts.itemsUnchanged).toBe(1);
    } finally {
      store.close();
    }
  });

  test('an item the store has never seen throws rather than being created', async () => {
    // The sink enriches, it never creates. Metadata sync must have run first.
    const store = newStore(tempDbPath('missing'));
    try {
      const text = 'Text for an item that was never synced.';
      const item = extractedTextItem('never-synced-1', text);
      expect(() => restore(store, item, expectationFor(item, text)))
        .toThrow('targeted store item is missing');
    } finally {
      store.close();
    }
  });

  test('an identity scoped to a different conversation is a different row, not a new one', async () => {
    // Same guarantee from the other direction: an identity that exists under a
    // different conversation scope is a different row, and the restore refuses
    // rather than inventing one.
    const store = newStore(tempDbPath('scoped'));
    try {
      const seeded = metadataOnlyItem('scoped-1');
      await store.syncFromConnector(createMetadataConnector([seeded]), { fetchContent: false });
      const text = 'Text targeted at the wrong conversation scope.';
      const item: RawItem = {
        ...extractedTextItem('scoped-1', text),
        identity: { ...identityFor('scoped-1'), providerConversationId: 'other-thread' },
      };
      expect(() => restore(store, item, expectationFor(item, text)))
        .toThrow('targeted store item is missing');
    } finally {
      store.close();
    }
  });

  // --- Negative controls: the ways this test is allowed to fail --------------

  test('NEGATIVE: dropping a chunk hash from the expectation breaks idempotency', async () => {
    const text = 'y'.repeat(CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS * 2 + 10);
    const { store, first, second } = await seedAndRestoreTwice({
      label: 'drop-chunk',
      itemId: 'drop-1',
      text,
      perturb: (expectation) => ({
        ...expectation,
        chunkContentHashes: expectation.chunkContentHashes.slice(0, -1),
      }),
    });
    try {
      expect(first.counts.itemsRestored).toBe(1);
      // Never settles: the store stored three chunks, the expectation claims
      // two, so coverage is incomplete on every subsequent pass.
      expect(second.counts.itemsRestored).toBe(1);
      expect(second.counts.itemsUnchanged).toBe(0);
    } finally {
      store.close();
    }
  });

  test("NEGATIVE: using the ref's provider digest as contentHash re-restores forever", async () => {
    const text = 'Extracted text with a mismatched expectation content hash.';
    const { store, first, second } = await seedAndRestoreTwice({
      label: 'wrong-content-hash',
      itemId: 'wrong-1',
      text,
      perturb: (expectation) => ({ ...expectation, contentHash: PROVIDER_DIGEST }),
    });
    try {
      expect(first.counts.itemsRestored).toBe(1);
      expect(second.counts.itemsRestored).toBe(1);
      expect(second.counts.itemsUnchanged).toBe(0);
    } finally {
      store.close();
    }
  });

  test('NEGATIVE: copying the provider digest into the synthetic item metadata breaks parity', async () => {
    // The inverse of the previous control, and the more tempting mistake: the
    // expectation is computed correctly but the synthetic item carries the
    // ref's contentHash in metadata, so the store writes the provider digest
    // into items.content_hash and the two never meet.
    const text = 'Extracted text whose item metadata carries the provider digest.';
    const { store, first, second, item } = await seedAndRestoreTwice({
      label: 'metadata-digest',
      itemId: 'metadata-digest-1',
      text,
      metadataContentHash: PROVIDER_DIGEST,
    });
    try {
      expect(first.counts.itemsRestored).toBe(1);
      expect(second.counts.itemsRestored).toBe(1);
      expect(second.counts.itemsUnchanged).toBe(0);
      expect(store.itemPresence(item.identity).contentHash).toBe(PROVIDER_DIGEST);
    } finally {
      store.close();
    }
  });

  test('NEGATIVE: chunking at a size the store will not use breaks idempotency', async () => {
    // maxChunkChars has to agree on both sides. Here the expectation is built
    // at half the store's default while the restore is left to default, so the
    // stored chunk count and the expected one disagree.
    const store = newStore(tempDbPath('chunk-size'));
    try {
      const itemId = 'chunk-size-1';
      const text = 'z'.repeat(CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS + 500);
      await store.syncFromConnector(
        createMetadataConnector([metadataOnlyItem(itemId)]),
        { fetchContent: false },
      );
      const item = extractedTextItem(itemId, text);
      const halfSize = CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS / 2;
      const mismatched: ConnectorStoreItemRepresentationExpectation = {
        sourceItem: item.identity,
        contentHash: connectorStoreHashString(text),
        chunkContentHashes: connectorStoreChunkText(text, halfSize).map(connectorStoreHashString),
      };
      expect(mismatched.chunkContentHashes).toHaveLength(3);
      expect(restore(store, item, mismatched).counts.itemsRestored).toBe(1);
      expect(restore(store, item, mismatched).counts.itemsRestored).toBe(1);
    } finally {
      store.close();
    }
  });
});
