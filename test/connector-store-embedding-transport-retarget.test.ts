// The 2026-08-20 private-host incident: LOCAL_EMBEDDING_BASE_URL moved from one
// loopback port to another — same model, same dimension, same pinned epoch,
// byte-identical vectors — and the write authority treated the changed
// configHash as a new provider identity. Every secure-local connector store
// rebound and deleted its whole vector corpus for the model.
//
// The rules this file pins:
//   1. Authority identity is what determines vector VALUES (provider kind,
//      model, backend, dimension, epoch). A transport retarget must not
//      invalidate a single stored vector, on the write side or the read side.
//   2. A change to any value-determining fact MUST still invalidate.
//   3. A rebind that WOULD invalidate proves the new provider can embed at
//      the declared width first, so a retarget to a dead or wrong endpoint
//      fails with the corpus intact instead of empty.

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  OpenAICompatibleSourceEmbeddingProvider,
  type SourceEmbeddingInput,
  type SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';
const MODEL_ID = 'secure-local-qwen3-embed';
const DIMENSION = 8;

const BODIES: ReadonlyArray<readonly [string, string]> = [
  ['id:one', 'first body about retros'],
  ['id:two', 'second body about roadmaps'],
  ['id:three', 'third body about budgets'],
];

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

async function seededStore(provider: SourceEmbeddingProvider): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'secure_local.fake.files',
    family: 'file',
    trustDomain: 'secure_local',
  });
  await store.syncFromConnector(connector(BODIES), { fetchContent: true });
  await store.embedChunks({ provider });
  return store;
}

// A real OpenAI-compatible provider whose endpoint is a counting fake: the
// exact class whose configHash folds the baseUrl in, which is the premise the
// incident stood on.
function endpointProvider(baseUrl: string): {
  provider: OpenAICompatibleSourceEmbeddingProvider;
  requests: () => number;
} {
  let requests = 0;
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    requests += 1;
    const body = JSON.parse(String((init as { body: string }).body)) as { input: string[] };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: body.input.map((_text, index) => ({
          index,
          embedding: Array.from({ length: DIMENSION }, (_v, i) => (i === 0 ? 1 : 0)),
        })),
      }),
    } as Response;
  }) as unknown as typeof fetch;
  return {
    provider: new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl,
      model: MODEL_ID,
      dimension: DIMENSION,
      fetchImpl,
    }),
    requests: () => requests,
  };
}

function fakeProvider(
  overrides: Partial<SourceEmbeddingProvider> = {},
  embed?: SourceEmbeddingProvider['embed'],
): SourceEmbeddingProvider {
  return {
    provider: 'fake-test-embeddings',
    modelId: MODEL_ID,
    dimension: 3,
    configHash: 'config-a',
    epochId: 'epoch-a',
    backend: 'local',
    embed: embed ?? (async (inputs: SourceEmbeddingInput[]) => inputs.map(() => [1, 0, 0])),
    ...overrides,
  };
}

function storeDb(store: LocalConnectorStore): Database {
  return (store as unknown as { db: Database }).db;
}

function embeddingRows(store: LocalConnectorStore): unknown[] {
  return storeDb(store).query(`
    SELECT chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at
    FROM chunk_embeddings ORDER BY chunk_pk, model_id
  `).all();
}

function authorityReceipt(store: LocalConnectorStore, modelId: string): unknown {
  return storeDb(store).query(`
    SELECT cursor, audit_receipt_sha256
    FROM sync_runs
    WHERE sync_run_id = ? AND connector_id = 'connector_store_embedding_write_authority'
  `).get(authorityId(modelId));
}

function authorityId(modelId: string): string {
  return `connector-store-embedding-write-authority:${createHash('sha256').update(modelId).digest('hex')}`;
}

function authorityCursor(
  provider: SourceEmbeddingProvider,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    kind: 'connector_store_embedding_write_authority_v2',
    modelId: provider.modelId,
    embeddingProvider: provider.provider,
    embeddingBackend: provider.backend,
    embeddingDimension: provider.dimension,
    embeddingEpoch: provider.epochId,
    embeddingConfigHash: provider.configHash,
    providerEpoch: 1,
    ...overrides,
  });
}

function replaceAuthority(
  store: LocalConnectorStore,
  modelId: string,
  cursor: string,
  digest = createHash('sha256').update(cursor).digest('hex'),
): void {
  const result = storeDb(store).query(`
    UPDATE sync_runs
    SET cursor = ?, audit_receipt_sha256 = ?
    WHERE sync_run_id = ? AND connector_id = 'connector_store_embedding_write_authority'
  `).run(cursor, digest, authorityId(modelId));
  expect(result.changes).toBe(1);
}

function embeddingRowsForModel(store: LocalConnectorStore, modelId: string): unknown[] {
  return storeDb(store).query(`
    SELECT chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at
    FROM chunk_embeddings WHERE model_id = ? ORDER BY chunk_pk
  `).all(modelId);
}

function embeddingModel(store: LocalConnectorStore, modelId: string): unknown {
  return storeDb(store).query(`
    SELECT provider, dimension, embedding_backend, embedding_epoch
    FROM embedding_models WHERE model_id = ?
  `).get(modelId);
}

function bindAuthority(
  store: LocalConnectorStore,
  provider: SourceEmbeddingProvider,
  mode: 'rebind' | 'match',
): number {
  const privateStore = store as unknown as {
    bindEmbeddingWriteAuthority(
      identity: SourceEmbeddingProvider,
      options: { mode: 'rebind' | 'match'; invalidateOnCreate: boolean },
    ): number;
  };
  return storeDb(store).transaction(() => privateStore.bindEmbeddingWriteAuthority(
    provider,
    { mode, invalidateOnCreate: false },
  ))();
}

describe('embedding write authority is transport-neutral', () => {
  test('a baseUrl-only retarget keeps every stored vector and the bound authority', async () => {
    const before = endpointProvider('http://127.0.0.1:28011/v1');
    const after = endpointProvider('http://127.0.0.1:28090/v1');
    // The incident's premise must still hold for this test to mean anything:
    // the transport location changes the configHash, and everything that
    // determines vector values is identical.
    expect(after.provider.configHash).not.toBe(before.provider.configHash);
    expect(after.provider.epochId).toBe(before.provider.epochId);
    expect(after.provider.modelId).toBe(before.provider.modelId);
    expect(after.provider.dimension).toBe(before.provider.dimension);

    const store = await seededStore(before.provider);
    const rowsBefore = embeddingRows(store);
    const receiptBefore = authorityReceipt(store, MODEL_ID);
    expect(rowsBefore).toHaveLength(BODIES.length);

    const summary = await store.embedChunks({ provider: after.provider });

    expect(summary.chunksEmbedded).toBe(0);
    expect(summary.chunksSkipped).toBe(BODIES.length);
    // No probe, no re-embed: the retargeted endpoint was never called.
    expect(after.requests()).toBe(0);
    expect(embeddingRows(store)).toEqual(rowsBefore);
    expect(authorityReceipt(store, MODEL_ID)).toEqual(receiptBefore);
    expect(store.hasEmbeddings(MODEL_ID)).toBe(true);

    // The read side accepts the retargeted provider too.
    const lane = await store.vectorSearchLane('retros', after.provider, 5);
    expect(lane.skippedReason).toBeUndefined();
    expect(lane.rows.length).toBeGreaterThan(0);
    store.close();
  });

  test.each([
    ['provider kind', { provider: 'replacement-provider' }],
    ['dimension', { dimension: 4 }],
    ['epoch', { epochId: 'epoch-b' }],
  ] as const)('a %s change still invalidates and re-embeds the corpus', async (_label, override) => {
    const store = await seededStore(fakeProvider());
    const rowsBefore = embeddingRows(store);
    expect(rowsBefore).toHaveLength(BODIES.length);

    const changed = fakeProvider(
      override,
      async (inputs: SourceEmbeddingInput[]) =>
        inputs.map(() => Array.from({ length: (override as { dimension?: number }).dimension ?? 3 }, () => 1)),
    );
    const summary = await store.embedChunks({ provider: changed });

    expect(summary.chunksEmbedded).toBe(BODIES.length);
    expect(summary.chunksSkipped).toBe(0);
    expect(embeddingRows(store)).not.toEqual(rowsBefore);
    expect(embeddingRows(store)).toHaveLength(BODIES.length);
    store.close();
  });

  test('a rebind whose provider cannot embed fails BEFORE any vector is deleted', async () => {
    const store = await seededStore(fakeProvider());
    const rowsBefore = embeddingRows(store);
    const receiptBefore = authorityReceipt(store, MODEL_ID);

    const dead = fakeProvider({ epochId: 'epoch-b' }, async () => {
      throw new Error('embedding endpoint is down');
    });
    await expect(store.embedChunks({ provider: dead })).rejects
      .toThrow('embedding endpoint is down');

    expect(embeddingRows(store)).toEqual(rowsBefore);
    expect(authorityReceipt(store, MODEL_ID)).toEqual(receiptBefore);
    expect(store.hasEmbeddings(MODEL_ID)).toBe(true);
    // The surviving corpus still serves under the identity that wrote it.
    const lane = await store.vectorSearchLane('retros', fakeProvider(), 5);
    expect(lane.skippedReason).toBeUndefined();
    expect(lane.rows.length).toBeGreaterThan(0);
    store.close();
  });

  test('a rebind whose provider answers with the wrong width fails BEFORE any vector is deleted', async () => {
    const store = await seededStore(fakeProvider());
    const rowsBefore = embeddingRows(store);
    const receiptBefore = authorityReceipt(store, MODEL_ID);

    const wrongWidth = fakeProvider(
      { epochId: 'epoch-b' },
      async (inputs: SourceEmbeddingInput[]) => inputs.map(() => [1, 0]),
    );
    await expect(store.embedChunks({ provider: wrongWidth })).rejects
      .toThrow('refused');

    expect(embeddingRows(store)).toEqual(rowsBefore);
    expect(authorityReceipt(store, MODEL_ID)).toEqual(receiptBefore);
    expect(store.hasEmbeddings(MODEL_ID)).toBe(true);
    store.close();
  });

  test('a digest-invalid authority refuses every writer and preserves current vectors', async () => {
    const provider = fakeProvider();
    const store = await seededStore(provider);
    const rowsBefore = embeddingRows(store);
    const cursor = authorityCursor(provider, { providerEpoch: 5 });
    replaceAuthority(store, provider.modelId, cursor, '0'.repeat(64));

    await expect(store.embedChunks({ provider })).rejects
      .toThrow('Connector store embedding write authority is corrupt.');

    expect(embeddingRows(store)).toEqual(rowsBefore);
    expect(authorityReceipt(store, provider.modelId)).toEqual({
      cursor,
      audit_receipt_sha256: '0'.repeat(64),
    });
    store.close();
  });

  test('a digest-verified legacy authority is superseded and re-embedded', async () => {
    const provider = fakeProvider();
    const store = await seededStore(provider);
    const legacy = authorityCursor(provider, {
      embeddingDimension: 0,
      providerEpoch: 7,
    });
    replaceAuthority(store, provider.modelId, legacy);

    const summary = await store.embedChunks({ provider });

    expect(summary).toMatchObject({
      chunksEmbedded: BODIES.length,
      chunksSkipped: 0,
    });
    const receipt = authorityReceipt(store, provider.modelId) as { cursor: string };
    expect(JSON.parse(receipt.cursor)).toMatchObject({
      embeddingDimension: provider.dimension,
      providerEpoch: 8,
    });
    expect(embeddingRowsForModel(store, provider.modelId)).toHaveLength(BODIES.length);
    store.close();
  });

  test('legacy supersession invalidates only the affected model', async () => {
    const current = fakeProvider();
    const other = fakeProvider({
      modelId: 'other-model',
      configHash: 'other-config',
      epochId: 'other-epoch',
    });
    const store = await seededStore(current);
    await store.embedChunks({ provider: other });
    const otherRows = embeddingRowsForModel(store, other.modelId);
    const otherAuthority = authorityReceipt(store, other.modelId);
    const legacy = authorityCursor(current, {
      embeddingDimension: 0,
      providerEpoch: 3,
    });
    replaceAuthority(store, current.modelId, legacy);

    await store.embedChunks({ provider: current });

    expect(embeddingRowsForModel(store, other.modelId)).toEqual(otherRows);
    expect(authorityReceipt(store, other.modelId)).toEqual(otherAuthority);
    store.close();
  });

  test('commit-time authority validation rolls back an in-flight batch', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.fake.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
    await store.syncFromConnector(connector(BODIES), { fetchContent: true });
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const provider = fakeProvider({}, async (inputs) => {
      startedResolve();
      await release;
      return inputs.map(() => [1, 0, 0]);
    });

    const inFlight = store.embedChunks({ provider });
    await started;
    const legacy = authorityCursor(provider, {
      embeddingDimension: 0,
      providerEpoch: 1,
    });
    replaceAuthority(store, provider.modelId, legacy);
    releaseResolve();

    await expect(inFlight).rejects
      .toThrow('Connector store embedding write authority is corrupt.');
    expect(embeddingRowsForModel(store, provider.modelId)).toEqual([]);
    expect(embeddingModel(store, provider.modelId)).toBeNull();
    store.close();
  });

  test('authority binding rejects invalid dimensions without rewriting state', () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.fake.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
    const invalid = fakeProvider({
      provider: 'invalid-dimension-provider',
      modelId: 'invalid-dimension-model',
      dimension: 0,
    });
    let error: unknown;
    try {
      bindAuthority(store, invalid, 'rebind');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ code: 'source_index_error' });
    expect((error as Error).message).toContain(invalid.provider);
    expect((error as Error).message).toContain(invalid.modelId);
    expect(authorityReceipt(store, invalid.modelId)).toBeNull();
    store.close();
  });

  test('valid production dimensions still mint and match authority', () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.fake.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
    for (const dimension of [2_560, 3_072]) {
      const provider = fakeProvider({
        modelId: `working-model-${dimension}`,
        dimension,
        configHash: `working-config-${dimension}`,
        epochId: `local:test:working-model-${dimension}:${dimension}`,
      });
      expect(bindAuthority(store, provider, 'rebind')).toBe(1);
      expect(bindAuthority(store, provider, 'match')).toBe(1);
    }
    store.close();
  });

  test('a pre-authority upgrade invalidates and re-embeds exactly once', async () => {
    const original = fakeProvider();
    const store = await seededStore(original);
    storeDb(store).query(`
      DELETE FROM sync_runs
      WHERE connector_id = 'connector_store_embedding_write_authority'
    `).run();
    expect(embeddingRowsForModel(store, original.modelId)).toHaveLength(BODIES.length);

    let calls = 0;
    const upgraded = fakeProvider({}, async (inputs) => {
      calls += 1;
      return inputs.map(() => [1, 0, 0]);
    });
    const first = await store.embedChunks({ provider: upgraded });
    expect(first).toMatchObject({ chunksEmbedded: BODIES.length, chunksSkipped: 0 });
    expect(calls).toBe(1);

    calls = 0;
    const second = await store.embedChunks({ provider: upgraded });
    expect(second).toMatchObject({ chunksEmbedded: 0, chunksSkipped: BODIES.length });
    expect(calls).toBe(0);
    store.close();
  });

  test('empty searchText values keep the canonical title fallback', async () => {
    const metadata: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
      ['omitted', { name: 'Quarterly plan' }],
      ['empty', { name: 'Quarterly plan', searchText: '' }],
      ['whitespace', { name: 'Quarterly plan', searchText: '   ' }],
    ];
    const items: RawItem[] = metadata.map(([id, itemMetadata]) => ({
      identity: {
        family: 'file',
        provider: 'fake',
        accountScope: ACCOUNT,
        providerItemId: id,
        localItemId: `${ACCOUNT}:${id}`,
      },
      mimeType: 'text/markdown',
      content: { kind: 'text', text: `body of ${id}` },
      metadata: Object.freeze(itemMetadata),
      fetchedAt: '2026-07-20T00:00:00.000Z',
    }));
    const source: SourceConnector = {
      id: 'search-text-boundary',
      family: 'file',
      async authenticate(): Promise<void> {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          yield { items, done: true };
        })();
      },
      async fetchItem(localItemId: string): Promise<RawItem> {
        const item = items.find((candidate) => candidate.identity.localItemId === localItemId);
        if (!item) throw new Error('unknown fixture item');
        return item;
      },
      classify: () => buildSourceSensitivity({
        trustDomain: 'secure_local',
        trustTier: 'S4',
      }),
    };
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.fake.files',
      family: 'file',
      trustDomain: 'secure_local',
    });

    await store.syncFromConnector(source, { fetchContent: true });
    const rows = storeDb(store).query(`
      SELECT provider_item_id, search_text FROM items ORDER BY provider_item_id
    `).all() as Array<{ provider_item_id: string; search_text: string | null }>;
    expect(rows).toEqual([
      { provider_item_id: 'empty', search_text: 'Quarterly plan' },
      { provider_item_id: 'omitted', search_text: 'Quarterly plan' },
      { provider_item_id: 'whitespace', search_text: 'Quarterly plan' },
    ]);
    store.close();
  });
});
