// Recall of a lower digest re-score cap against the exact scan, on real
// question vectors, for one store of an offline data-root copy. Read-only;
// prints counts and timings only, never text or ids.
//   bun eval/vector-rescore-cap.ts --data-root <copy> --corpus internal.dropbox.files \
//     --questions <file, one question per line> [--caps 1000,2000,20000] [--limit 24]
// For each question: the exact top `limit` items (every current vector,
// cosine, no digest), then the two-pass digest scan at each cap. Reported per
// cap: how many of the exact top items the capped scan also ranks in its top
// `limit`, how many questions match exactly, and the re-score reads it made
// (each one a 256-row random read, about 1.2 s cold on the live store).
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.ts';
import { connectorStoreCurrentEmbeddingRowsIterator, scanDigestPages } from '../src/workers/connector-store/local-index.ts';
import type { StoreRead } from '../src/workers/connector-store/off-thread-reads.ts';
import { cosineSimilarity, decodeEmbedding } from '../src/workers/source-index/embeddings.ts';
import { openEvalDataRoot } from './data-root.ts';
import { parseDataRootArgs } from './data-root-args.ts';
import { configuredEvalEmbedding, prepareEvalEmbedding } from './retrieval.ts';

const MIN_VECTOR_SCORE = 0.18; // the lane's bar (local-index.ts)

function flags(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) if (argv[i]!.startsWith('--')) values.set(argv[i]!.slice(2), argv[i + 1] ?? '');
  return values;
}

function topItems(best: Map<number, number>, limit: number): number[] {
  return [...best].filter(([, score]) => score >= MIN_VECTOR_SCORE)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit).map(([pk]) => pk);
}

async function main(): Promise<void> {
  const { isolation, rest } = parseDataRootArgs(process.argv.slice(2));
  if (!isolation) throw new Error('--data-root is required.');
  const values = flags(rest);
  const corpus = values.get('corpus');
  const questionsFile = values.get('questions');
  if (!corpus || !questionsFile) throw new Error('--corpus and --questions are required.');
  const questions = readFileSync(questionsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
  const caps = (values.get('caps') ?? '1000,2000,20000').split(',').map(Number);
  const limit = Number(values.get('limit') ?? 24);
  const opened = openEvalDataRoot(isolation);
  const store = opened.stores.find(candidate => candidate.corpusId === corpus);
  if (!store) throw new Error(`No store ${corpus} in the copy.`);
  const embedding = await prepareEvalEmbedding({ configured: await configuredEvalEmbedding(loadConfig(), process.env) });
  const provider = embedding.embeddingFor(store.trustDomain);
  if (!provider) throw new Error('No embedding provider for that store.');
  const options = { modelId: provider.modelId };
  const db = new Database(store.dbPath, { readonly: true, create: false, strict: true });
  db.exec('PRAGMA query_only = ON');
  const totals = new Map(caps.map(cap => [cap, { kept: 0, identical: 0, rescoreReads: 0, ms: 0 }]));
  let exactItems = 0;
  db.exec('BEGIN DEFERRED TRANSACTION');
  try {
    for (const question of questions) {
      const [vector] = await provider.embed([{ text: question }], { taskType: 'RETRIEVAL_QUERY' });
      if (!vector) throw new Error('The embedding provider returned no vector.');
      const best = new Map<number, number>();
      for (const row of connectorStoreCurrentEmbeddingRowsIterator(db, options)) {
        const stored = decodeEmbedding(row.embedding);
        if (stored.length !== vector.length) continue;
        const score = cosineSimilarity(vector, stored);
        if (score > (best.get(row.itemPk) ?? -Infinity)) best.set(row.itemPk, score);
      }
      const exact = topItems(best, limit);
      exactItems += exact.length;
      for (const cap of caps) {
        let rescoreReads = 0;
        const read = async (query: StoreRead): Promise<unknown> => {
          if (query.sql.includes('emb.chunk_pk IN')) rescoreReads += 1;
          const params = query.params as Array<string | number | null>;
          return query.mode === 'all' ? db.query(query.sql).all(...params) : db.query(query.sql).get(...params);
        };
        const started = performance.now();
        const scan = await scanDigestPages(read, vector, options, undefined, limit, cap);
        const total = totals.get(cap)!;
        total.ms += performance.now() - started;
        if ('skippedReason' in scan) throw new Error(scan.skippedReason);
        const capped = topItems(new Map([...scan.bestByItem].map(([pk, row]) => [pk, row.bestCosine])), limit);
        total.kept += exact.filter(pk => capped.includes(pk)).length;
        total.identical += Number(exact.length === capped.length && exact.every((pk, at) => pk === capped[at]));
        total.rescoreReads += rescoreReads;
      }
    }
  } finally { db.exec('ROLLBACK'); db.close(); }
  console.log(JSON.stringify({ corpus, questions: questions.length, limit, exactItems,
    caps: caps.map(cap => { const total = totals.get(cap)!; return { cap, keptOfExact: total.kept, identicalQuestions: total.identical,
      meanRescoreReads: +(total.rescoreReads / questions.length).toFixed(1), meanWarmMs: Math.round(total.ms / questions.length) }; }) }));
  for (const each of opened.stores) each.close();
}

await main();
