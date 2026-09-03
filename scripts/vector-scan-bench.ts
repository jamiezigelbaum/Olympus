#!/usr/bin/env bun
/**
 * Before/after measurement for the vector-scan rewrite, against a real
 * connector store.
 *
 * The rewrite's claim is narrow and checkable: the scan produces the SAME
 * scores in the same order, using far less memory and time, because it stopped
 * boxing every stored vector into a JS number[] via `Array.from`. This script
 * runs both implementations over the same rows in one process and prints the
 * timings side by side plus a score-identity check, so the claim can be
 * confirmed on the host that actually holds the corpus rather than inferred
 * from a laptop.
 *
 * Read-only. It opens the store read-only, embeds nothing, and prints counts,
 * timings and score deltas only — never item text, identifiers or vectors.
 *
 *   bun scripts/vector-scan-bench.ts --db <path> [--model <id>] [--account <scope>] [--trials 5]
 *
 * The "before" path is reproduced here rather than imported, because the point
 * is to compare against code that no longer exists.
 */
import { Database } from 'bun:sqlite';
import { connectorStoreCurrentEmbeddingRows, connectorStoreCurrentEmbeddingRowsIterator } from '../src/workers/connector-store/index.ts';
import { cosineSimilarity, decodeEmbedding } from '../src/workers/source-index/embeddings.ts';

interface BenchOptions {
  dbPath: string;
  modelId?: string;
  accountScope?: string;
  trials: number;
  /**
   * Runs one implementation only. Peak RSS is a per-process high-water mark, so
   * the memory half of the claim can only be measured by running each side in
   * its own process: `/usr/bin/time -l bun scripts/vector-scan-bench.ts --only
   * before ...` against the same with `--only after`.
   */
  only?: 'before' | 'after';
}

function parseArgs(argv: readonly string[]): BenchOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) continue;
    values.set(arg.slice(2), argv[index + 1] ?? '');
  }
  const dbPath = values.get('db');
  if (!dbPath) throw new Error('Usage: bun scripts/vector-scan-bench.ts --db <store.sqlite> [--model <id>] [--account <scope>] [--trials 5] [--only before|after]');
  const trials = Number.parseInt(values.get('trials') ?? '5', 10);
  const only = values.get('only');
  if (only !== undefined && only !== 'before' && only !== 'after') {
    throw new Error('--only must be before or after.');
  }
  return {
    dbPath,
    ...(values.get('model') ? { modelId: values.get('model')! } : {}),
    ...(values.get('account') ? { accountScope: values.get('account')! } : {}),
    trials: Number.isFinite(trials) && trials > 0 ? trials : 5,
    ...(only ? { only } : {}),
  };
}

// --- the pre-rewrite implementation, verbatim --------------------------------

function legacyDecodeEmbedding(value: unknown): number[] {
  const bytes = value as Uint8Array;
  const usableBytes = bytes.byteLength - (bytes.byteLength % 4);
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, usableBytes / 4));
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

// --- the two scans -----------------------------------------------------------

interface ScanOptions {
  modelId: string;
  accountScope?: string;
}

function legacyScan(db: Database, query: number[], options: ScanOptions): Map<number, number> {
  const rows = connectorStoreCurrentEmbeddingRows(db, options);
  const best = new Map<number, number>();
  for (const row of rows) {
    const score = legacyCosineSimilarity(query, legacyDecodeEmbedding(row.embedding));
    const existing = best.get(row.itemPk);
    if (existing === undefined || score > existing) best.set(row.itemPk, score);
  }
  return best;
}

function currentScan(db: Database, query: number[], options: ScanOptions): Map<number, number> {
  const best = new Map<number, number>();
  for (const row of connectorStoreCurrentEmbeddingRowsIterator(db, options)) {
    const score = cosineSimilarity(query, decodeEmbedding(row.embedding));
    const existing = best.get(row.itemPk);
    if (existing === undefined || score > existing) best.set(row.itemPk, score);
  }
  return best;
}

// --- driver ------------------------------------------------------------------

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function heapMb(): number {
  return Math.round((process.memoryUsage().heapUsed / 1_048_576) * 10) / 10;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const db = new Database(options.dbPath, { readonly: true, strict: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');

    const modelId = options.modelId ?? (db.query(
      'SELECT model_id FROM chunk_embeddings GROUP BY model_id ORDER BY COUNT(*) DESC LIMIT 1',
    ).get() as { model_id: string } | null)?.model_id;
    if (!modelId) throw new Error('No embedding model found in this store; pass --model.');

    const scanOptions: ScanOptions = {
      modelId,
      ...(options.accountScope ? { accountScope: options.accountScope } : {}),
    };

    const sample = db.query(
      'SELECT embedding FROM chunk_embeddings WHERE model_id = ? LIMIT 1',
    ).get(modelId) as { embedding: unknown } | null;
    if (!sample) throw new Error(`Model ${modelId} has no vectors in this store.`);
    const dimension = decodeEmbedding(sample.embedding).length;

    // A real stored vector makes the query representative: an arbitrary random
    // query would sit near-orthogonal to everything and is not what the lane
    // ever sees. Scores are compared, not reported, so no content escapes.
    const query = Array.from(decodeEmbedding(sample.embedding));

    console.log(`store        ${options.dbPath}`);
    console.log(`model        ${modelId}`);
    console.log(`dimension    ${dimension}`);
    console.log(`account      ${options.accountScope ?? '(unscoped)'}`);
    console.log(`trials       ${options.trials}`);

    const vectorCountEarly = (db.query(
      'SELECT COUNT(*) AS count FROM chunk_embeddings WHERE model_id = ?',
    ).get(modelId) as { count: number }).count;

    if (options.only) {
      // Single-implementation mode exists for peak-RSS measurement, so it does
      // exactly one scan and nothing else that would allocate.
      const scan = options.only === 'before' ? legacyScan : currentScan;
      const started = Bun.nanoseconds();
      const scores = scan(db, query, scanOptions);
      const elapsed = (Bun.nanoseconds() - started) / 1e6;
      console.log(`${options.only} ${elapsed.toFixed(0)} ms over ${vectorCountEarly} vectors, ${scores.size} items scored`);
      return;
    }

    // Correctness before speed: if the scores differ at all, the timings are
    // measuring two different questions and mean nothing.
    const legacyScores = legacyScan(db, query, scanOptions);
    const currentScores = currentScan(db, query, scanOptions);
    let mismatches = 0;
    for (const [itemPk, score] of legacyScores) {
      if (currentScores.get(itemPk) !== score) mismatches += 1;
    }
    console.log(`vectors      ${vectorCountEarly}`);
    console.log(`items scored ${legacyScores.size} (before) / ${currentScores.size} (after)`);
    console.log(`score deltas ${mismatches} of ${legacyScores.size} differ`);

    const legacyMs: number[] = [];
    const currentMs: number[] = [];
    for (let trial = 0; trial < options.trials; trial += 1) {
      let started = Bun.nanoseconds();
      legacyScan(db, query, scanOptions);
      legacyMs.push((Bun.nanoseconds() - started) / 1e6);
      const legacyHeap = heapMb();

      started = Bun.nanoseconds();
      currentScan(db, query, scanOptions);
      currentMs.push((Bun.nanoseconds() - started) / 1e6);
      console.log(
        `trial ${trial + 1}  before ${legacyMs[trial]!.toFixed(0)} ms (heap ${legacyHeap} MB)`
        + `  after ${currentMs[trial]!.toFixed(0)} ms (heap ${heapMb()} MB)`,
      );
    }

    const before = medianOf(legacyMs);
    const after = medianOf(currentMs);
    console.log(`median       before ${before.toFixed(0)} ms   after ${after.toFixed(0)} ms   speedup ${(before / after).toFixed(1)}x`);
    if (mismatches > 0) {
      console.log('FAIL: scores changed. The rewrite is only allowed to change how vectors are held, not what is compared.');
      process.exitCode = 1;
    }
  } finally {
    db.close(false);
  }
}

main();
