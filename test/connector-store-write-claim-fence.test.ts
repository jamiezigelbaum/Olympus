// The corpus-side generation fence.
//
// A producer that asks its own queue "do I still hold this work?" is reading a
// DIFFERENT database, so the answer is already the past by the time it writes.
// A recycle landing in that gap gave the job to somebody else, who wrote their
// text here — and then the superseded producer's write replaced it, with the
// queue reporting the new holder as the winner over content that was not
// theirs. The ledger closes that by making the decision inside the write's own
// transaction: a grant that is not strictly newer than the last one accepted
// for this item and scope does not write.
//
// The other half of the design is what the fence must NOT do. Ordinals only
// order within the sequence that minted them, so a grant from another
// authority — a second queue, or the same queue rebuilt — takes the row over
// instead of being refused. Refusing it would mean that recreating a
// producer's database silently wedges every write into this corpus for ever.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  connectorStoreChunkText,
  connectorStoreHashString,
  CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS,
} from '../src/workers/connector-store/index.ts';

const CORPUS_ID = 'secure_local.fake.files';
const PROVIDER = 'fake';
const ACCOUNT = 'personal';
const ITEM_ID = 'item-1';
const LOCAL_ITEM_ID = `${ACCOUNT}:${ITEM_ID}`;
const SCOPE = 'local_text';
const AUTHORITY = 'queue-authority-1';

function item(): RawItem {
  return {
    identity: {
      family: 'file',
      provider: PROVIDER,
      accountScope: ACCOUNT,
      providerItemId: ITEM_ID,
      localItemId: LOCAL_ITEM_ID,
      sourceVersion: 'rev-1',
    },
    mimeType: 'application/pdf',
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({ name: 'Quarterly Report.pdf', locator: '/Files/Quarterly Report.pdf' }),
    fetchedAt: '2026-07-20T00:00:00.000Z',
  };
}

function connector(): SourceConnector {
  return {
    id: 'family-connector',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: [item()], done: true };
      })();
    },
    async fetchItem(): Promise<RawItem> {
      return item();
    },
    classify(): ReturnType<SourceConnector['classify']> {
      return buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' });
    },
  };
}

async function seededStore(): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'write-claim-fence-')), 'store.sqlite'),
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  await store.syncFromConnector(connector(), { fetchContent: false });
  return store;
}

function restore(
  store: LocalConnectorStore,
  text: string,
  claim?: { authority?: string; ordinal: number; scope?: string },
): ReturnType<LocalConnectorStore['restoreItemRepresentations']> {
  const identity = item().identity;
  return store.restoreItemRepresentations({
    syncConnectorId: 'extraction-factory-pass',
    ownerConnectorId: 'family-connector',
    ownershipKind: 'observed',
    classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
    items: [{
      item: { ...item(), content: { kind: 'text', text } },
      expectation: {
        sourceItem: identity,
        sourceVersion: identity.sourceVersion!,
        contentHash: connectorStoreHashString(text),
        chunkContentHashes: connectorStoreChunkText(
          text,
          CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS,
        ).map(connectorStoreHashString),
      },
    }],
    ...(claim
      ? {
        writeClaim: {
          scope: claim.scope ?? SCOPE,
          authority: claim.authority ?? AUTHORITY,
          ordinal: claim.ordinal,
          holder: 'job-1',
          generation: connectorStoreHashString(`token-${claim.ordinal}`),
        },
      }
      : {}),
  });
}

describe('connector store write-claim fence', () => {
  test('a superseded grant is refused and the newer content stands', async () => {
    const store = await seededStore();
    try {
      const newHolder = restore(store, 'the CURRENT holder read this', { ordinal: 7 });
      expect(newHolder.counts.itemsRestored).toBe(1);
      expect(newHolder.counts.itemsSkippedStaleClaim).toBe(0);

      const superseded = restore(store, 'the SUPERSEDED worker read this', { ordinal: 6 });

      expect(superseded.counts.itemsSkippedStaleClaim).toBe(1);
      expect(superseded.counts.itemsRestored).toBe(0);
      expect(superseded.skippedProviderItemIds).toEqual([ITEM_ID]);
      expect(store.localContent(LOCAL_ITEM_ID)!.chunks).toEqual(['the CURRENT holder read this']);
    } finally {
      store.close();
    }
  });

  test('the same grant twice is refused: a generation writes once', async () => {
    const store = await seededStore();
    try {
      expect(restore(store, 'first', { ordinal: 3 }).counts.itemsRestored).toBe(1);
      const replay = restore(store, 'second', { ordinal: 3 });

      expect(replay.counts.itemsSkippedStaleClaim).toBe(1);
      expect(store.localContent(LOCAL_ITEM_ID)!.chunks).toEqual(['first']);
    } finally {
      store.close();
    }
  });

  test('a newer grant writes over an older one, which is the ordinary case', async () => {
    const store = await seededStore();
    try {
      restore(store, 'first pass', { ordinal: 1 });
      const second = restore(store, 'second pass', { ordinal: 2 });

      expect(second.counts.itemsRestored).toBe(1);
      expect(store.localContent(LOCAL_ITEM_ID)!.chunks).toEqual(['second pass']);
    } finally {
      store.close();
    }
  });

  test('a grant from another authority takes the ledger over instead of wedging it', async () => {
    const store = await seededStore();
    try {
      restore(store, 'written under the old queue', { ordinal: 900 });

      // The producer's database was rebuilt: same work, ordinals restarted, and
      // a new authority id saying so. Comparing the two would refuse every
      // write into this corpus for ever.
      const rebuilt = restore(store, 'written under the rebuilt queue', {
        authority: 'queue-authority-2',
        ordinal: 1,
      });

      expect(rebuilt.counts.itemsRestored).toBe(1);
      expect(rebuilt.counts.itemsSkippedStaleClaim).toBe(0);
      expect(store.localContent(LOCAL_ITEM_ID)!.chunks).toEqual(['written under the rebuilt queue']);
    } finally {
      store.close();
    }
  });

  test('scopes are ordered independently, so two producers do not fence each other', async () => {
    const store = await seededStore();
    try {
      restore(store, 'read by the first extractor', { ordinal: 5 });
      const other = restore(store, 'read by the second extractor', { ordinal: 2, scope: 'ocr' });

      expect(other.counts.itemsRestored).toBe(1);
      expect(store.localContent(LOCAL_ITEM_ID)!.chunks).toEqual(['read by the second extractor']);
    } finally {
      store.close();
    }
  });

  test('a restore with no claim is unfenced, exactly as it was', async () => {
    const store = await seededStore();
    try {
      restore(store, 'claimed write', { ordinal: 4 });
      const unclaimed = restore(store, 'unclaimed write');

      expect(unclaimed.counts.itemsRestored).toBe(1);
      expect(unclaimed.counts.itemsSkippedStaleClaim).toBe(0);
      expect(store.localContent(LOCAL_ITEM_ID)!.chunks).toEqual(['unclaimed write']);
    } finally {
      store.close();
    }
  });

  test('a malformed grant is a producer defect and is refused loudly', async () => {
    const store = await seededStore();
    try {
      expect(() => restore(store, 'body', { ordinal: 0 }))
        .toThrow('ordinal must be a positive integer');
      expect(() => restore(store, 'body', { ordinal: 1, authority: '  ' }))
        .toThrow('authority is required');
    } finally {
      store.close();
    }
  });
});
