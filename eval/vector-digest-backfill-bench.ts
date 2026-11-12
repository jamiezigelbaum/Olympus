// Counts-only bench for the #1444 digest backfill on a SCRATCH copy of one
// connector store file. Never point it at a live store or at an eval copy
// that other runs use: it writes the digest tables into the file it opens.
//
//   backfill:  bun eval/vector-digest-backfill-bench.ts backfill --store SCRATCH.sqlite --model MODEL
//   scan loop: bun eval/vector-digest-backfill-bench.ts scan --store SCRATCH.sqlite --model MODEL --stop STOPFILE
//
// The backfill mode runs the worker's own bounded turns (same row bounds and
// time-based shrinking) and reports read and write times apart, event-loop
// lag and lock retries. The scan mode, run in a second process at the same time, times the
// exact scan read-only until the stop file appears, so scans during backfill
// can be compared with an idle baseline.
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { connectorStoreCurrentEmbeddingRowsIterator, nextVectorDigestBackfillRows } from '../src/workers/connector-store/local-index.ts';
import { applyVectorDigestWindow, createVectorDigestSchema, vectorDigestSourceQuery, vectorDigestState, type VectorDigestSourceRow } from '../src/workers/connector-store/vector-digest.ts';
import { cosineSimilarity, decodeEmbedding } from '../src/workers/source-index/embeddings.ts';

function summary(values: number[]): { n: number; max: number; p99: number; p50: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
  return { n: sorted.length, max: Math.round(at(1) * 10) / 10, p99: Math.round(at(0.99) * 10) / 10, p50: Math.round(at(0.5) * 10) / 10 };
}

async function backfill(path: string, modelId: string): Promise<Record<string, unknown>> {
  const db = new Database(path, { create: false, strict: true });
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  createVectorDigestSchema(db);
  // The worker reads each window on the read pool and only writes here, so
  // the read and the write are timed apart; the write is what its thread pays.
  const reader = new Database(path, { readonly: true, create: false, strict: true });
  reader.exec('PRAGMA query_only = ON');
  const reads: number[] = [];
  const turns: number[] = [];
  const lags: number[] = [];
  let last = performance.now();
  const lagTimer = setInterval(() => { const now = performance.now(); lags.push(Math.max(0, now - last - 10)); last = now; }, 10);
  let rows = 128, busy = 0, scanned = 0;
  const started = performance.now();
  try {
    for (;;) {
      const cursor = vectorDigestState(db, modelId);
      if (cursor.completed) break;
      const readStart = performance.now();
      const query = vectorDigestSourceQuery(cursor.cursorRowid, rows);
      const source = reader.query(query.sql).all(...query.params) as VectorDigestSourceRow[];
      reads.push(performance.now() - readStart);
      const turnStart = performance.now();
      let state;
      try { state = applyVectorDigestWindow(db, modelId, cursor.cursorRowid, source, rows); } catch (error) {
        if (/busy|locked/i.test(String(error))) { busy++; await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
        throw error;
      }
      const ms = performance.now() - turnStart;
      turns.push(ms);
      rows = nextVectorDigestBackfillRows(rows, ms + reads.at(-1)!);
      scanned += state.scanned;
      if (state.completed) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally { clearInterval(lagTimer); }
  const totalMs = Math.round(performance.now() - started);
  const digests = (db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest WHERE model_id = ?').get(modelId) as { n: number }).n;
  db.close();
  reader.close();
  // eventLoopLagMs here includes the reads; in the worker they run on the pool.
  return { mode: 'backfill', totalMs, rowsScanned: scanned, digests, busyRetries: busy, poolReadMs: summary(reads), writeTurnMs: summary(turns), eventLoopLagMs: summary(lags) };
}

function scanLoop(path: string, modelId: string, stop: string): Record<string, unknown> {
  const db = new Database(path, { readonly: true, create: false, strict: true });
  db.exec('PRAGMA query_only = ON');
  const first = db.query('SELECT embedding FROM chunk_embeddings WHERE model_id = ? LIMIT 1').get(modelId) as { embedding: Uint8Array } | null;
  if (!first) throw new Error('No vectors for that model');
  const query = Array.from(decodeEmbedding(first.embedding));
  const times: number[] = [];
  do {
    const start = performance.now();
    let checksum = 0;
    for (const row of connectorStoreCurrentEmbeddingRowsIterator(db, { modelId })) checksum += cosineSimilarity(query, decodeEmbedding(row.embedding));
    if (!Number.isFinite(checksum)) throw new Error('Invalid vectors');
    times.push(performance.now() - start);
  } while (!existsSync(stop));
  db.close();
  return { mode: 'scan', exactScanMs: summary(times) };
}

if (import.meta.main) {
  const value = (flag: string) => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
  const mode = process.argv[2], path = value('--store'), modelId = value('--model');
  if (!path || !modelId || (mode !== 'backfill' && mode !== 'scan')) throw new Error('Usage: backfill|scan --store PATH --model MODEL [--stop FILE]');
  const result = mode === 'backfill' ? await backfill(path, modelId) : scanLoop(path, modelId, value('--stop') ?? `${path}.stop`);
  console.log(JSON.stringify(result));
}
