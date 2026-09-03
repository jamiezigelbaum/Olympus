// Restoring representations onto a row that was removed while the job queued.
//
// `restoreItemRepresentations` looked its target up by identity alone, and the
// upsert underneath it clears `tombstoned` unconditionally — so an extraction
// finishing after a reconcile proved the item gone put the item back, with its
// content, and nothing reported that it had. The refusal is a COUNTED SKIP
// rather than a throw: the extraction runner handing over a row that was
// removed mid-flight is behaving correctly, and aborting the batch around it
// would turn one removed item into a failed lane.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  EXTRACTION_SINK_SKIPPED_ITEM_MISSING,
  createConnectorStoreExtractionSink,
} from '../src/workers/file-extraction/store-sink.ts';
import type { ExtractionSinkRequest } from '../src/workers/file-extraction/types.ts';

const CORPUS_ID = 'secure_local.fake.files';
const PROVIDER = 'fake';
const ACCOUNT = 'personal';
const ITEM_ID = 'item-1';
const LOCAL_ITEM_ID = `${ACCOUNT}:${ITEM_ID}`;
const SCOPE_KEY = 'fake.personal:/Files';

function item(deleted = false): RawItem {
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
    metadata: Object.freeze({
      name: 'Quarterly Report.pdf',
      locator: '/Files/Quarterly Report.pdf',
      ...(deleted ? { deleted: true } : {}),
    }),
    fetchedAt: '2026-07-20T00:00:00.000Z',
  };
}

function connector(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'family-connector',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: [...items], done: true };
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

function request(text: string): ExtractionSinkRequest {
  return {
    ref: {
      corpusId: CORPUS_ID,
      provider: PROVIDER,
      accountScope: ACCOUNT,
      approvedScopeKey: SCOPE_KEY,
      providerItemId: ITEM_ID,
      localItemId: LOCAL_ITEM_ID,
      mimeType: 'application/pdf',
      name: 'Quarterly Report.pdf',
    },
    text,
    extractorKind: 'local_text',
    extractorVersion: 'test-v1',
    fetchedAt: '2026-07-20T00:00:00.000Z',
  };
}

async function tombstonedStore(): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'restore-tombstone-')), 'store.sqlite'),
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  await store.syncFromConnector(connector([item()]), { fetchContent: false });
  // The provider reports it deleted; the store tombstones the row.
  await store.syncFromConnector(connector([item(true)]), { fetchContent: false });
  return store;
}

describe('representation restore never resurrects a removed item', () => {
  test('the extraction sink reports a removed row as missing instead of writing it back', async () => {
    const store = await tombstonedStore();
    try {
      const sink = createConnectorStoreExtractionSink({
        store,
        classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
        syncConnectorId: 'extraction-factory-pass',
        ownerConnectorId: 'family-connector',
        ownershipKind: 'observed',
      });

      const result = await sink.accept(request('the extracted body of the report'));

      expect(result.accepted).toBe(false);
      expect(result.skippedReason).toBe(EXTRACTION_SINK_SKIPPED_ITEM_MISSING);
      expect(result.chunksIndexed).toBe(0);
      // Still removed, and still holding no content.
      expect(store.localContent(LOCAL_ITEM_ID)).toBeUndefined();
      expect(store.searchItems('extracted body of the report', 5)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test('the store counts the skip rather than throwing the batch away', async () => {
    const store = await tombstonedStore();
    try {
      const summary = store.restoreItemRepresentations({
        syncConnectorId: 'extraction-factory-pass',
        ownerConnectorId: 'family-connector',
        ownershipKind: 'observed',
        classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
        items: [{
          item: {
            ...item(),
            content: { kind: 'text', text: 'the extracted body of the report' },
          },
          expectation: {
            sourceItem: item().identity,
            contentHash: 'restored-body-hash',
            chunkContentHashes: [],
          },
        }],
      });

      expect(summary.counts.itemsSkippedTombstoned).toBe(1);
      expect(summary.counts.itemsRestored).toBe(0);
      expect(summary.skippedProviderItemIds).toEqual([ITEM_ID]);
    } finally {
      store.close();
    }
  });
});
