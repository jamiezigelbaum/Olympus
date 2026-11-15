// The real vector lane on one store of an offline data-root copy, timed read
// by read. Counts, ids and timings only: no item text is printed.
//   bun eval/vector-lane-one-store.ts --data-root <copy> --corpus internal.dropbox.files \
//     --query-file <file with the question> [--trials 3] [--max-results 24] [--deadline-ms 54000]
// Read-only. Each read's time is measured from when it is sent to when the
// next read of that store is sent; the scan's reads run one at a time.
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.ts';
import { setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { poolSqlSite } from '../src/workers/source-index/answer-latency-trace.ts';
import { openEvalDataRoot } from './data-root.ts';
import { parseDataRootArgs } from './data-root-args.ts';
import { configuredEvalEmbedding, prepareEvalEmbedding } from './retrieval.ts';

function flags(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) if (argv[i]!.startsWith('--')) values.set(argv[i]!.slice(2), argv[i + 1] ?? '');
  return values;
}

async function main(): Promise<void> {
  const { isolation, rest } = parseDataRootArgs(process.argv.slice(2));
  if (!isolation) throw new Error('--data-root is required.');
  const values = flags(rest);
  const corpus = values.get('corpus');
  const queryFile = values.get('query-file');
  if (!corpus || !queryFile) throw new Error('--corpus and --query-file are required.');
  const query = readFileSync(queryFile, 'utf8').trim();
  const trials = Number(values.get('trials') ?? 3);
  const maxResults = Number(values.get('max-results') ?? 24);
  const deadlineMs = Number(values.get('deadline-ms') ?? 54_000);
  const opened = openEvalDataRoot(isolation);
  const store = opened.stores.find(candidate => candidate.corpusId === corpus);
  if (!store) throw new Error(`No store ${corpus} in the copy.`);
  const embedding = await prepareEvalEmbedding({ configured: await configuredEvalEmbedding(loadConfig(), process.env) });
  const provider = embedding.embeddingFor(store.trustDomain);
  if (!provider) throw new Error('No embedding provider for that store.');
  let reads: Array<{ site: string; sentAt: number }> = [];
  setReadPoolObserverForTests((dbPath, read) => { if (dbPath === store.dbPath) reads.push({ site: poolSqlSite(read.sql), sentAt: performance.now() }); }, { snapshots: true });
  for (let trial = 1; trial <= trials; trial++) {
    reads = [];
    const started = performance.now();
    const lane = await store.vectorSearchLane(query, provider, maxResults, undefined, undefined, Date.now() + deadlineMs);
    const ended = performance.now();
    const sites = new Map<string, { reads: number; ms: number; maxMs: number }>();
    reads.forEach((read, at) => {
      const ms = (reads[at + 1]?.sentAt ?? ended) - read.sentAt;
      const entry = sites.get(read.site) ?? { reads: 0, ms: 0, maxMs: 0 };
      entry.reads += 1; entry.ms += ms; entry.maxMs = Math.max(entry.maxMs, ms);
      sites.set(read.site, entry);
    });
    console.log(JSON.stringify({
      trial, corpus, laneMs: Math.round(ended - started), rows: lane.rows.length,
      ...(lane.skippedReason ? { skippedReason: lane.skippedReason } : {}),
      itemIds: lane.rows.map(row => row.sourceItem.localItemId),
      sites: [...sites].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6)
        .map(([site, entry]) => ({ site: site.slice(0, 60), reads: entry.reads, ms: Math.round(entry.ms), maxMs: Math.round(entry.maxMs) })),
    }));
  }
  setReadPoolObserverForTests();
  for (const opened_ of opened.stores) opened_.close();
}

await main();
