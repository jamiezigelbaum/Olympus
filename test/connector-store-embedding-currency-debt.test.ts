// Rebinding the embedding write authority clears model currency across the
// WHOLE corpus, but the call that triggers it usually repairs only its own
// selection — an incremental sync page, a facet-refresh page. The gap between
// the two is the debt this file pins: while it stands, the store must not
// report a servable vector lane, because one freshly written vector would
// otherwise make an existence probe answer for a corpus that is mostly empty.
//
// What retires the debt is EVIDENCE that no live chunk is still missing a
// current vector — not the shape of the call that arrived. Keying it to an
// unselected, unlimited pass made it unpayable in practice, because
// `syncAndEmbedFromConnector` always passes `localItemIds`: every scheduler
// lane rebuilt the corpus page by page and the vector lane stayed off forever.

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
const MODEL_ID = 'currency-debt-model';

function rawItem(id: string, text: string): RawItem {
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
    metadata: Object.freeze({ name: `${id}.md` }),
    fetchedAt: '2026-07-20T00:00:00.000Z',
  };
}

function connector(items: readonly (readonly [string, string])[]): SourceConnector {
  return {
    id: 'fake',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: items.map(([id, text]) => rawItem(id, text)), done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const entry = items.find(([id]) => `${ACCOUNT}:${id}` === localItemId);
      if (!entry) throw new Error(`no such item ${localItemId}`);
      return rawItem(entry[0], entry[1]);
    },
    classify(): ReturnType<SourceConnector['classify']> {
      return buildSourceSensitivity({ trustDomain: 'secure_local', trustTier: 'S4' });
    },
  };
}

// Same model id, different provider identity — the swap the authority epoch
// exists for, and the one that deletes every vector under that model. The
// epoch carries the identity change; configHash alone carries no authority.
function provider(configHash: string, seen?: string[]): SourceEmbeddingProvider {
  return {
    provider: 'fake-test-embeddings',
    modelId: MODEL_ID,
    dimension: 3,
    configHash,
    epochId: `currency-debt-epoch:${configHash}`,
    backend: 'local',
    async embed(inputs: SourceEmbeddingInput[]): Promise<number[][]> {
      if (seen) for (const input of inputs) seen.push(input.text);
      return inputs.map(() => [1, 0, 0]);
    },
  };
}

const BODIES: ReadonlyArray<readonly [string, string]> = [
  ['id:one', 'first body about retros'],
  ['id:two', 'second body about roadmaps'],
  ['id:three', 'third body about budgets'],
];

async function seededStore(seen?: string[]): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'secure_local.fake.files',
    family: 'file',
    trustDomain: 'secure_local',
  });
  await store.syncFromConnector(connector(BODIES), { fetchContent: true });
  await store.embedChunks({ provider: provider('config-one', seen) });
  return store;
}

describe('embedding currency after a provider rebind', () => {
  test('selection-scoped pages leave the lane unservable until the last gap closes', async () => {
    const store = await seededStore();
    expect(store.hasEmbeddings(MODEL_ID)).toBe(true);

    // A provider identity change discovered by an ordinary incremental page:
    // every vector for the model is deleted, only this page is re-embedded.
    const partial = await store.embedChunks({
      provider: provider('config-two'),
      localItemIds: [`${ACCOUNT}:id:one`],
    });
    expect(partial.chunksEmbedded).toBe(1);

    expect(store.hasEmbeddings(MODEL_ID)).toBe(false);

    // A page that repairs part of the remainder does not pay it either.
    await store.embedChunks({
      provider: provider('config-two'),
      localItemIds: [`${ACCOUNT}:id:two`],
    });
    expect(store.hasEmbeddings(MODEL_ID)).toBe(false);

    // The page that closes the LAST gap pays it, selection-scoped or not.
    await store.embedChunks({
      provider: provider('config-two'),
      localItemIds: [`${ACCOUNT}:id:three`],
    });
    expect(store.hasEmbeddings(MODEL_ID)).toBe(true);
    store.close();
  });

  test('a bounded corpus-wide pass pays the debt only once it closes the last gap', async () => {
    const store = await seededStore();
    await store.embedChunks({
      provider: provider('config-two'),
      localItemIds: [`${ACCOUNT}:id:one`],
    });
    expect(store.hasEmbeddings(MODEL_ID)).toBe(false);

    await store.embedChunks({ provider: provider('config-two'), limit: 1 });
    expect(store.hasEmbeddings(MODEL_ID)).toBe(false);

    await store.embedChunks({ provider: provider('config-two'), limit: 1 });
    expect(store.hasEmbeddings(MODEL_ID)).toBe(true);
    store.close();
  });

  test('a selection that repairs nothing outstanding cannot pay the debt', async () => {
    const store = await seededStore();
    await store.embedChunks({
      provider: provider('config-two'),
      localItemIds: [`${ACCOUNT}:id:one`],
    });
    expect(store.hasEmbeddings(MODEL_ID)).toBe(false);

    // Re-embedding the page that is already current writes nothing and proves
    // nothing about the two items that are still owed.
    await store.embedChunks({
      provider: provider('config-two'),
      localItemIds: [`${ACCOUNT}:id:one`],
    });
    expect(store.hasEmbeddings(MODEL_ID)).toBe(false);
    store.close();
  });


  test('an ordinary corpus-wide embed with no rebind keeps the lane servable', async () => {
    const store = await seededStore();
    expect(store.hasEmbeddings(MODEL_ID)).toBe(true);
    await store.embedChunks({ provider: provider('config-one') });
    expect(store.hasEmbeddings(MODEL_ID)).toBe(true);
    await store.embedChunks({
      provider: provider('config-one'),
      localItemIds: [`${ACCOUNT}:id:one`],
    });
    expect(store.hasEmbeddings(MODEL_ID)).toBe(true);
    store.close();
  });
});
