// Read-only, counts-only probe. First connection pass is cold to SQLite;
// OS cache eviction is deliberately left to the operator.
// bun eval/vector-digest-probe.ts --store /path/store.sqlite --model MODEL --queries 20 [--account SCOPE]
import { Database } from 'bun:sqlite';
import { connectorStoreCurrentEmbeddingRowsIterator, connectorStoreVectorDigestPageQuery, scanDigestPages } from '../src/workers/connector-store/local-index.ts';
import { cosineSimilarity, decodeEmbedding } from '../src/workers/source-index/embeddings.ts';
import { encodeVectorDigest, scoreVectorDigest } from '../src/workers/source-index/vector-digest.ts';
import type { StoreRead } from '../src/workers/connector-store/off-thread-reads.ts';

export function seededVectorRandom(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

export async function probeVectorDigest(db: Database, options: { modelId: string; accountScope?: string; queries: number; seed?: number }): Promise<Record<string, unknown>> {
  if (!Number.isInteger(options.queries) || options.queries < 1) throw new Error('queries must be a positive integer');
  db.exec('BEGIN DEFERRED TRANSACTION');
  try {
    const ready = db.query('SELECT completed FROM chunk_vector_digest_meta WHERE model_id = ?').get(options.modelId) as { completed: number } | null;
    if (ready?.completed !== 1) throw new Error('Model digest backfill is incomplete');
    const read = async (query: StoreRead): Promise<unknown> => {
      const params = query.params as Array<string | number | null>;
      return query.mode === 'all' ? db.query(query.sql).all(...params) : db.query(query.sql).get(...params);
    };
    const first = db.query(`SELECT emb.embedding FROM chunk_embeddings emb WHERE emb.model_id = ? LIMIT 1`).get(options.modelId) as { embedding: Uint8Array } | null;
    if (!first) return { queries: 0, vectors: 0 };
    const query = encodeVectorDigest(decodeEmbedding(first.embedding));
    function timeDigest(): { ms: number; vectors: number } {
      const start = performance.now();
      let after = 0, vectors = 0, checksum = 0;
      while (true) {
        const page = connectorStoreVectorDigestPageQuery(options, after);
        const rows = db.query(page.sql).all(...page.params) as Array<{ chunk_pk: number; digest: Uint8Array }>;
        for (const row of rows) checksum += scoreVectorDigest(query, row.digest);
        vectors += rows.length;
        if (rows.length < 4096) break;
        after = rows.at(-1)!.chunk_pk;
      }
      if (!Number.isFinite(checksum)) throw new Error('Invalid digest dimensions');
      return { ms: performance.now() - start, vectors };
    }
    const coldConnection = timeDigest();
    const warm = timeDigest();
    const random = seededVectorRandom(options.seed ?? 1444);
    const queries: number[][] = [];
    let seen = 0;
    // Reservoir sampling: N actual current vectors, no ORDER BY random() blob sort.
    for (const row of connectorStoreCurrentEmbeddingRowsIterator(db, options)) {
      seen++;
      const slot = seen <= options.queries ? seen - 1 : Math.floor(random() * seen);
      if (slot < options.queries) queries[slot] = Array.from(decodeEmbedding(row.embedding));
    }
    let identical = 0, overlap = 0, exactMs = 0, twoPassMs = 0, top30InCandidates = 0;
    for (const vector of queries) {
      let start = performance.now();
      const best = new Map<number, number>();
      for (const row of connectorStoreCurrentEmbeddingRowsIterator(db, options)) {
        const stored = decodeEmbedding(row.embedding);
        if (stored.length !== vector.length) continue;
        const score = cosineSimilarity(vector, stored);
        if (score >= 0.18 && score > (best.get(row.itemPk) ?? -Infinity)) best.set(row.itemPk, score);
      }
      const exact30 = [...best].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 30).map(([pk]) => pk);
      const exact = exact30.slice(0, 20);
      exactMs += performance.now() - start;
      start = performance.now();
      const result = await scanDigestPages(read, vector, options, undefined, 20);
      if ('skippedReason' in result) throw new Error(result.skippedReason);
      // Merge condition 1 (#1444): the exact top 30 must sit inside the re-scored candidates.
      top30InCandidates += Number(exact30.every((pk) => result.bestByItem.has(pk)));
      const approximate = [...result.bestByItem].filter(([, row]) => row.bestCosine >= 0.18)
        .sort((a, b) => b[1].bestCosine - a[1].bestCosine || a[0] - b[0]).slice(0, 20).map(([pk]) => pk);
      twoPassMs += performance.now() - start;
      overlap += exact.filter(pk => approximate.includes(pk)).length;
      identical += Number(exact.length === approximate.length && exact.every((pk, i) => pk === approximate[i]));
    }
    return { coldConnection, warm, eligibleVectors: seen, queries: queries.length, identicalTop20Queries: identical,
      top20OverlapCount: overlap, top30InCandidatesQueries: top30InCandidates, exactMs, twoPassMs };
  } finally { db.exec('ROLLBACK'); }
}

if (import.meta.main) {
  const value = (flag: string) => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
  const path = value('--store'), modelId = value('--model'), accountScope = value('--account');
  if (!path || !modelId) throw new Error('Required: --store PATH --model MODEL [--queries N] [--account SCOPE]');
  const db = new Database(path, { readonly: true, create: false, strict: true });
  try {
    db.exec('PRAGMA query_only = ON');
    console.log(JSON.stringify(await probeVectorDigest(db, { modelId, queries: Number(value('--queries') ?? 20), ...(accountScope ? { accountScope } : {}) })));
  } finally { db.close(); }
}
