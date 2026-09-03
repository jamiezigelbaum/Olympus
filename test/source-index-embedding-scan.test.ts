// Guards for the 2026-07-28 vector-scan rewrite.
//
// The rewrite changed HOW a stored vector is held in memory, never WHAT is
// compared: `decodeEmbedding` hands back a Float32Array view over the blob
// instead of boxing it into a JS number[], and the connector-store vector lane
// streams rows instead of materialising every eligible vector at once. The
// measured cost of the boxing on the live Telegram corpus was ~14.3s of a
// ~17.5s query — about 96% — against 0.56s of actual arithmetic.
//
// Because the whole claim is "same answer, less garbage", these tests pin the
// two things that would make that claim false:
//
//   1. Scores and ranking are IDENTICAL to the pre-rewrite algorithm, which is
//      reproduced verbatim below and used as ground truth. Not "close" —
//      identical, including the exact float64 bit pattern, because the same
//      float32 values are summed in the same order.
//   2. Account scope stays a SQL pre-filter. An out-of-scope vector must never
//      reach the scoring loop at all, so the guard watches the row stream
//      rather than only the returned rows: filtering after the scan would look
//      identical from the outside and would be a trust-boundary failure.

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  connectorStoreCurrentEmbeddingRows,
  connectorStoreCurrentEmbeddingRowsIterator,
} from '../src/workers/connector-store/index.ts';
import {
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  type SourceEmbeddingInput,
  type SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

const DIMENSION = 64;
const MODEL_ID = 'scan-guard-embed-v1';

// --- The pre-rewrite implementations, verbatim -------------------------------
//
// Copied from git history rather than imported, on purpose: their whole job is
// to be the thing the new code is checked against, so they must not be able to
// drift with it.

function legacyDecodeEmbedding(value: unknown): number[] {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new Error('not a blob');
  }
  const usableBytes = bytes.byteLength - (bytes.byteLength % 4);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, usableBytes / 4);
  return Array.from(floats);
}

function legacyCosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

// --- Vector fixtures ---------------------------------------------------------

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function unitVector(seed: number, dimension = DIMENSION): number[] {
  const random = seededRandom(seed);
  const raw = Array.from({ length: dimension }, () => random() * 2 - 1);
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

function blobOf(vector: number[]): Uint8Array {
  return encodeEmbedding(vector, vector.length);
}

// --- Store fixture -----------------------------------------------------------

interface ScanFixtureItem {
  id: string;
  accountScope: string;
  text: string;
  vector: number[];
  deleted?: boolean;
}

function createScanConnector(
  accountScope: string,
  items: readonly ScanFixtureItem[],
): SourceConnector {
  const scoped = items.filter((item) => item.accountScope === accountScope);
  const rawItem = (item: ScanFixtureItem): RawItem => ({
    identity: {
      family: 'file',
      provider: 'scan-guard',
      accountScope: item.accountScope,
      providerItemId: item.id,
      providerFileId: item.id,
      localItemId: `${item.accountScope}:${item.id}`,
      sourceVersion: 'rev-1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: item.text },
    metadata: Object.freeze({
      deleted: item.deleted === true,
      name: `${item.id}.txt`,
      clientModifiedAt: '2026-07-01T10:00:00.000Z',
      serverModifiedAt: '2026-07-01T10:00:00.000Z',
    }),
    fetchedAt: '2026-07-20T00:00:00.000Z',
  });
  return {
    id: 'scan-guard',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(_options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: scoped.map(rawItem), done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = scoped.find((candidate) => `${candidate.accountScope}:${candidate.id}` === localItemId);
      if (!item) throw new Error(`no item ${localItemId}`);
      return rawItem(item);
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}

// Embeds by lookup on the fixture text, so a chunk's vector is whatever the
// fixture planted for it and the query vector is planted separately.
function createPlantedProvider(
  items: readonly ScanFixtureItem[],
  queryVector: number[],
): SourceEmbeddingProvider {
  return {
    provider: 'scan-guard-embeddings',
    modelId: MODEL_ID,
    dimension: DIMENSION,
    configHash: 'scan-guard-config',
    epochId: `local:scan-guard-embeddings:${MODEL_ID}:${DIMENSION}`,
    backend: 'local',
    async embed(
      inputs: SourceEmbeddingInput[],
      options: { taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' },
    ): Promise<number[][]> {
      if (options.taskType === 'RETRIEVAL_QUERY') return inputs.map(() => [...queryVector]);
      return inputs.map((input) => {
        const match = items.find((item) => input.text.includes(item.text));
        if (!match) throw new Error(`fixture has no vector for ${input.text.slice(0, 40)}`);
        return [...match.vector];
      });
    },
  };
}

async function buildScanStore(items: readonly ScanFixtureItem[], queryVector: number[]): Promise<{
  store: LocalConnectorStore;
  provider: SourceEmbeddingProvider;
}> {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'scan-guard-')), 'store.sqlite');
  const store = new LocalConnectorStore({
    corpusId: 'secure_local.scan.guard',
    dbPath,
    family: 'file',
    trustDomain: 'secure_local',
  });
  const provider = createPlantedProvider(items, queryVector);
  for (const accountScope of new Set(items.map((item) => item.accountScope))) {
    await store.syncFromConnector(createScanConnector(accountScope, items), { fetchContent: true });
  }
  await store.embedChunks({ provider });
  return { store, provider };
}

// Building a store means a fresh SQLite file, the full migration chain, two
// connector syncs and an embed pass. The read-only tests all want the SAME
// store, so it is built once and shared; the tests that mutate rows to check
// the eligibility rules take their own via buildScanStore.
let sharedFixture: Promise<{ store: LocalConnectorStore; provider: SourceEmbeddingProvider }> | undefined;

function sharedScanStore(): Promise<{ store: LocalConnectorStore; provider: SourceEmbeddingProvider }> {
  sharedFixture ??= buildScanStore(FIXTURE_ITEMS, QUERY_VECTOR);
  return sharedFixture;
}

afterAll(async () => {
  if (sharedFixture) (await sharedFixture).store.close();
});

function storeDb(store: LocalConnectorStore): Database {
  return (store as unknown as { db: Database }).db;
}

// Mirrors the store's own MIN_VECTOR_SCORE, which is module-private. A copy is
// correct here: the ground-truth scan has to apply the same floor the lane
// applies, and if the lane's floor moves this test should notice.
const MIN_VECTOR_SCORE = 0.18;

// The pre-rewrite scan, over the ordered row helper the probe still uses.
function legacyScanScores(
  db: Database,
  queryVector: number[],
  accountScope?: string,
): Map<string, number> {
  const rows = connectorStoreCurrentEmbeddingRows(db, {
    modelId: MODEL_ID,
    ...(accountScope ? { accountScope } : {}),
  });
  const best = new Map<string, number>();
  for (const row of rows) {
    const score = legacyCosineSimilarity(queryVector, legacyDecodeEmbedding(row.embedding));
    const existing = best.get(row.localItemId);
    if (existing === undefined || score > existing) best.set(row.localItemId, score);
  }
  for (const [localItemId, score] of best) {
    if (score < MIN_VECTOR_SCORE) best.delete(localItemId);
  }
  return best;
}

// --- decodeEmbedding ---------------------------------------------------------

describe('decodeEmbedding', () => {
  test('returns exactly the values the boxing implementation returned', () => {
    for (const seed of [1, 7, 4_242, 99_991]) {
      const blob = blobOf(unitVector(seed));
      expect(Array.from(decodeEmbedding(blob))).toEqual(legacyDecodeEmbedding(blob));
    }
  });

  test('handles the same odd payload shapes the boxing implementation did', () => {
    const vector = unitVector(11, 8);
    const blob = blobOf(vector);
    // Raw ArrayBuffer.
    expect(Array.from(decodeEmbedding(blob.buffer))).toEqual(legacyDecodeEmbedding(blob.buffer));
    // Trailing bytes that do not complete a float are dropped, not rounded up.
    const ragged = new Uint8Array(blob.byteLength + 3);
    ragged.set(blob);
    expect(decodeEmbedding(ragged)).toHaveLength(vector.length);
    expect(Array.from(decodeEmbedding(ragged))).toEqual(legacyDecodeEmbedding(ragged));
    // A non-BLOB payload is still refused rather than silently scored as zero.
    expect(() => decodeEmbedding('not a blob')).toThrow();
  });

  test('does not copy the blob — it views it', () => {
    // This is the regression guard for the actual defect. `Array.from` allocated
    // ~20 KB per row, per query; a view allocates nothing. If someone
    // reintroduces a copy the scan silently gets its 96% overhead back, and no
    // score-level assertion anywhere would notice.
    const blob = blobOf(unitVector(3));
    const decoded = decodeEmbedding(blob);
    expect(decoded).toBeInstanceOf(Float32Array);
    expect(decoded.buffer).toBe(blob.buffer);
    expect(decoded.byteOffset).toBe(blob.byteOffset);
  });

  test('survives an unaligned payload by copying only in that case', () => {
    const vector = unitVector(5, 8);
    const blob = blobOf(vector);
    const shifted = new Uint8Array(blob.byteLength + 1);
    shifted.set(blob, 1);
    const unaligned = new Uint8Array(shifted.buffer, 1, blob.byteLength);
    expect(Array.from(decodeEmbedding(unaligned))).toEqual(vector.map((v) => Math.fround(v)));
  });
});

// --- cosineSimilarity --------------------------------------------------------

describe('cosineSimilarity', () => {
  test('is bit-identical to the pre-rewrite scorer over boxed and unboxed inputs', () => {
    for (const seed of [2, 13, 555, 20_260_728]) {
      const query = unitVector(seed);
      const stored = unitVector(seed + 1);
      const blob = blobOf(stored);
      const expected = legacyCosineSimilarity(query, legacyDecodeEmbedding(blob));
      // Same float64 result, not merely a close one: identical float32 values
      // summed in identical order must produce identical bits.
      expect(cosineSimilarity(query, decodeEmbedding(blob))).toBe(expected);
    }
  });

  test('keeps cosine semantics for vectors that are not unit length', () => {
    // The stored corpus happens to be L2-normalized today, which is why a bare
    // dot product looked tempting. It is not equivalent: MIN_VECTOR_SCORE and
    // the semantic relevance bar are fixed thresholds on a value in [-1, 1], so
    // a provider that ever returned unnormalized vectors would not degrade, it
    // would move every score across those bars at once.
    const direction = unitVector(21);
    const scaled = direction.map((value) => value * 17.5);
    expect(cosineSimilarity(direction, scaled)).toBeCloseTo(1, 12);
    expect(cosineSimilarity(direction, scaled)).toBe(legacyCosineSimilarity(direction, scaled));
    const dotProduct = direction.reduce((sum, value, index) => sum + value * scaled[index]!, 0);
    expect(dotProduct).toBeGreaterThan(17);
  });

  test('matches the pre-rewrite scorer on degenerate inputs', () => {
    const zero = new Array(DIMENSION).fill(0) as number[];
    const unit = unitVector(31);
    expect(cosineSimilarity(zero, unit)).toBe(legacyCosineSimilarity(zero, unit));
    expect(cosineSimilarity(unit, zero)).toBe(legacyCosineSimilarity(unit, zero));
    // Length mismatch truncates to the shorter side, as before.
    const short = unit.slice(0, 8);
    expect(cosineSimilarity(unit, short)).toBe(legacyCosineSimilarity(unit, short));
    // Opposed vectors stay negative rather than clamping.
    const opposed = unit.map((value) => -value);
    expect(cosineSimilarity(unit, opposed)).toBeCloseTo(-1, 12);
  });
});

// --- the connector-store vector lane ----------------------------------------

const QUERY_VECTOR = unitVector(1_001);

// Blends the query with independent noise so a fixture vector lands at a chosen
// cosine. Random unit vectors in any real dimension are near-orthogonal, which
// would put every fixture item under MIN_VECTOR_SCORE and make the ranking
// assertions vacuous.
function blendedVector(similarity: number, seed: number): number[] {
  const noise = unitVector(seed);
  const blended = QUERY_VECTOR.map((value, index) => value * similarity + noise[index]! * (1 - similarity));
  const norm = Math.sqrt(blended.reduce((sum, value) => sum + value * value, 0));
  return blended.map((value) => value / norm);
}

// Two accounts, and a pair of items sharing one vector exactly so the ranking
// has a genuine tie to break. Duplicated content is normal in a real corpus.
const SHARED_VECTOR = blendedVector(0.5, 1_010);
const FIXTURE_ITEMS: readonly ScanFixtureItem[] = [
  { id: 'a-near', accountScope: 'personal', text: 'alpha near query', vector: blendedVector(0.95, 1_002) },
  { id: 'a-mid', accountScope: 'personal', text: 'alpha mid distance', vector: blendedVector(0.7, 1_003) },
  { id: 'a-dup1', accountScope: 'personal', text: 'alpha duplicated one', vector: SHARED_VECTOR },
  { id: 'a-dup2', accountScope: 'personal', text: 'alpha duplicated two', vector: SHARED_VECTOR },
  { id: 'b-near', accountScope: 'work', text: 'bravo near query', vector: blendedVector(0.9, 1_004) },
  { id: 'b-mid', accountScope: 'work', text: 'bravo mid distance', vector: blendedVector(0.65, 1_005) },
  { id: 'b-far', accountScope: 'work', text: 'bravo far away', vector: blendedVector(0.4, 1_006) },
];

describe('connector-store vector lane', () => {
  test('scores and ranks identically to the pre-rewrite scan', async () => {
    const { store, provider } = await sharedScanStore();
    {
      const scored = await store.vectorSearchItemsWithScores('find the near one', provider, 10);
      const expected = legacyScanScores(storeDb(store), QUERY_VECTOR);

      // Every returned score is the exact float the old code produced.
      for (const row of scored) {
        expect(row.bestCosine).toBe(expected.get(row.sourceItem.localItemId)!);
      }
      // And the order is the old order: descending score, ties by insertion,
      // which the ordered scan made item_pk order.
      const expectedOrder = [...expected.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([localItemId]) => localItemId);
      expect(scored.map((row) => row.sourceItem.localItemId)).toEqual(expectedOrder);
    }
  });

  test('breaks exact ties deterministically', async () => {
    const { store, provider } = await sharedScanStore();
    {
      const runs = await Promise.all([1, 2, 3].map(
        () => store.vectorSearchItemsWithScores('find the near one', provider, 10),
      ));
      const orders = runs.map((rows) => rows.map((row) => row.sourceItem.localItemId));
      expect(orders[1]).toEqual(orders[0]!);
      expect(orders[2]).toEqual(orders[0]!);
      // The tie is real: the two duplicated items scored the same.
      const scores = new Map(runs[0]!.map((row) => [row.sourceItem.localItemId, row.bestCosine]));
      expect(scores.get('personal:a-dup1')).toBe(scores.get('personal:a-dup2')!);
    }
  });

  test('account scope pre-filters the scan, not the results', async () => {
    const { store, provider } = await sharedScanStore();
    {
      // The row stream itself must never carry another account's vector. A
      // post-filter would return the same rows below while still having read,
      // decoded and scored private data from the wrong account.
      const streamed = [...connectorStoreCurrentEmbeddingRowsIterator(storeDb(store), {
        modelId: MODEL_ID,
        accountScope: 'personal',
      })];
      expect(streamed.length).toBeGreaterThan(0);
      expect(streamed.every((row) => row.localItemId.startsWith('personal:'))).toBe(true);

      const scoped = await store.vectorSearchItemsWithScores('find the near one', provider, 10, 'personal');
      expect(scoped.length).toBeGreaterThan(0);
      expect(scoped.every((row) => row.sourceItem.accountScope === 'personal')).toBe(true);
      expect(scoped.some((row) => row.sourceItem.localItemId.startsWith('work:'))).toBe(false);

      // The other account is genuinely reachable — the assertion above is not
      // passing because the fixture is empty on that side.
      const other = await store.vectorSearchItemsWithScores('find the near one', provider, 10, 'work');
      expect(other.every((row) => row.sourceItem.accountScope === 'work')).toBe(true);
      expect(other.length).toBeGreaterThan(0);
    }
  });

  test('scoped scores match an independently scoped ground-truth scan', async () => {
    const { store, provider } = await sharedScanStore();
    {
      for (const accountScope of ['personal', 'work']) {
        const scored = await store.vectorSearchItemsWithScores('find the near one', provider, 10, accountScope);
        const expected = legacyScanScores(storeDb(store), QUERY_VECTOR, accountScope);
        expect(scored.map((row) => row.sourceItem.localItemId).sort())
          .toEqual([...expected.keys()].sort());
        for (const row of scored) {
          expect(row.bestCosine).toBe(expected.get(row.sourceItem.localItemId)!);
        }
      }
    }
  });

  test('the streaming and ordered row helpers select the same rows', async () => {
    const { store } = await sharedScanStore();
    {
      const db = storeDb(store);
      for (const accountScope of [undefined, 'personal', 'work']) {
        const options = { modelId: MODEL_ID, ...(accountScope ? { accountScope } : {}) };
        const ordered = connectorStoreCurrentEmbeddingRows(db, options);
        const streamed = [...connectorStoreCurrentEmbeddingRowsIterator(db, options)];
        expect(streamed).toHaveLength(ordered.length);
        expect(streamed.map((row) => row.localItemId).sort())
          .toEqual(ordered.map((row) => row.localItemId).sort());
      }
    }
  });
});

describe('hasEmbeddings', () => {
  test('answers the same question the unbounded COUNT(*) answered', async () => {
    const { store, provider } = await buildScanStore(FIXTURE_ITEMS, QUERY_VECTOR);
    try {
      expect(store.hasEmbeddings(MODEL_ID)).toBe(true);
      expect(store.hasEmbeddings('a-model-that-never-ran')).toBe(false);

      // Stale vectors do not count: the currency rule is
      // embedding.content_hash = chunk.embedding_input_hash, and breaking it
      // must flip the answer to false rather than leave a corpus advertising
      // semantics it cannot serve.
      const db = storeDb(store);
      db.run("UPDATE chunk_embeddings SET content_hash = 'stale-' || content_hash");
      expect(store.hasEmbeddings(MODEL_ID)).toBe(false);
    } finally {
      store.close();
    }
  });

  test('a tombstoned corpus stops advertising embeddings', async () => {
    const { store } = await buildScanStore(FIXTURE_ITEMS, QUERY_VECTOR);
    try {
      const db = storeDb(store);
      expect(store.hasEmbeddings(MODEL_ID)).toBe(true);
      db.run('UPDATE items SET tombstoned = 1');
      expect(store.hasEmbeddings(MODEL_ID)).toBe(false);
    } finally {
      store.close();
    }
  });
});
