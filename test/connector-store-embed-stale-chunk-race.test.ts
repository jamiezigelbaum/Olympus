// `embedChunks` snapshots (chunk_pk, item_pk, embedding_input_hash) for every
// candidate chunk BEFORE it awaits the provider, then writes vectors keyed on
// those captured chunk_pks. The X lane runs its head and its reconcile under
// two different concurrency keys against one store, and the unbounded
// `POST /source/index/embed` drain grinds for minutes, so a concurrent
// tombstone or re-chunk between the snapshot and the write is ordinary.
//
// chunk_embeddings has a foreign key onto chunks, so the stale write used to
// abort the whole batch transaction and throw the pass away — and where SQLite
// had reused the freed rowid, it stored a vector computed over the OLD text
// against the NEW chunk. The write is now conditional on the captured chunk
// still being there with the same embedding input, and a no-op write is a
// counted skip.

import { describe, expect, test } from 'bun:test';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type {
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';
const MODEL_ID = 'stale-chunk-race-model';

function rawItem(id: string, text: string, deleted = false): RawItem {
  return {
    identity: {
      family: 'file',
      provider: 'fake',
      accountScope: ACCOUNT,
      providerItemId: id,
      localItemId: `${ACCOUNT}:${id}`,
      sourceVersion: 'rev-1',
    },
    mimeType: 'text/markdown',
    content: { kind: 'text', text },
    metadata: Object.freeze({ name: `${id}.md`, ...(deleted ? { deleted: true } : {}) }),
    fetchedAt: '2026-07-20T00:00:00.000Z',
  };
}

function connector(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'fake',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: [...items], done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const found = items.find((item) => item.identity.localItemId === localItemId);
      if (!found) throw new Error(`no such item ${localItemId}`);
      return found;
    },
    classify(): ReturnType<SourceConnector['classify']> {
      return buildSourceSensitivity({ trustDomain: 'secure_local', trustTier: 'S4' });
    },
  };
}

function racingProvider(onFirstBatch: () => Promise<void>): SourceEmbeddingProvider {
  let raced = false;
  return {
    provider: 'fake-test-embeddings',
    modelId: MODEL_ID,
    dimension: 3,
    configHash: 'stale-chunk-race',
    epochId: 'stale-chunk-race-epoch',
    backend: 'local',
    async embed(inputs: SourceEmbeddingInput[]): Promise<number[][]> {
      // The provider round trip is the window: another lane owns the store
      // while this batch is out.
      if (!raced) {
        raced = true;
        await onFirstBatch();
      }
      return inputs.map(() => [1, 0, 0]);
    },
  };
}

async function seededStore(): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'secure_local.fake.files',
    family: 'file',
    trustDomain: 'secure_local',
  });
  await store.syncFromConnector(
    connector([rawItem('id:one', 'first body about retros'), rawItem('id:two', 'second body about roadmaps')]),
    { fetchContent: true },
  );
  return store;
}

describe('embedChunks survives a chunk removed while its vectors were in flight', () => {
  test('a tombstone during the provider call is a counted skip, not an aborted pass', async () => {
    const store = await seededStore();
    const provider = racingProvider(async () => {
      await store.syncFromConnector(
        connector([rawItem('id:two', 'second body about roadmaps', true)]),
        { fetchContent: true },
      );
    });

    const summary = await store.embedChunks({ provider });

    expect(summary.chunksSeen).toBe(2);
    expect(summary.chunksEmbedded).toBe(1);
    expect(summary.chunksSkipped).toBe(1);
    // The surviving chunk really is servable, and the tombstoned one left no
    // vector behind.
    expect(store.hasEmbeddings(MODEL_ID)).toBe(true);
    store.close();
  });

  test('a re-chunk during the provider call does not attach the old vector', async () => {
    const store = await seededStore();
    const provider = racingProvider(async () => {
      await store.syncFromConnector(
        connector([rawItem('id:two', 'second body, rewritten entirely between passes')]),
        { fetchContent: true },
      );
    });

    const summary = await store.embedChunks({ provider });

    expect(summary.chunksEmbedded).toBe(1);
    expect(summary.chunksSkipped).toBe(1);

    // The rewritten item is still owed a vector; a stale write would have
    // satisfied the currency rule with a vector for text that no longer exists.
    const second = await store.embedChunks({
      provider: racingProvider(async () => {}),
      localItemIds: [`${ACCOUNT}:id:two`],
    });
    expect(second.chunksEmbedded).toBe(1);
    store.close();
  });
});
