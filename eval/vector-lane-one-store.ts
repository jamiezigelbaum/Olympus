// The real vector lane on one store of an offline data-root copy, timed read
// by read. Counts, ids and timings only: no item text is printed.
//   bun eval/vector-lane-one-store.ts --data-root <copy> --corpus internal.dropbox.files \
//     --query-file <file with the question> [--trials 3] [--max-results 24] [--deadline-ms 54000]
//     [--live-scope --registry <connected handle registry> [--source dropbox.files] [--account personal]]
// --live-scope searches with the account scope and filters the live Ask
// passes (the source's approved folder scope, as the engine builds them),
// and prints the re-score page's EXPLAIN QUERY PLAN with them.
// Read-only. Each read's time is measured from when it is sent to when the
// next read of that store is sent; the scan's reads run one at a time.
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.ts';
import { connectorStoreCurrentEmbeddingPageQuery, type ConnectorStoreSearchFilters } from '../src/workers/connector-store/local-index.ts';
import { setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { FileSourceScopeAuthority, fileSourceScopeMetadataFilters } from '../src/workers/source-scope-runtime.ts';
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
  let accountScope: string | undefined;
  let filters: ConnectorStoreSearchFilters | undefined;
  if (rest.includes('--live-scope')) {
    const registryPath = values.get('registry');
    if (!registryPath) throw new Error('--live-scope needs --registry.');
    const approval = new FileSourceScopeAuthority({ registryPath }).snapshot(values.get('source') ?? 'dropbox.files');
    const scope = fileSourceScopeMetadataFilters(approval);
    if (!scope.allowed) throw new Error(`The source scope is not approved (${approval.status}).`);
    filters = scope.filters;
    accountScope = values.get('account') ?? 'personal';
    const db = new Database(store.dbPath, { readonly: true, create: false, strict: true });
    try {
      const onDemandReadsTablePresent = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'on_demand_item_reads'").get());
      const chunkPks = (db.query('SELECT chunk_pk FROM chunk_embeddings WHERE model_id = ? LIMIT 480').all(provider.modelId) as Array<{ chunk_pk: number }>).map(row => row.chunk_pk);
      const page = connectorStoreCurrentEmbeddingPageQuery({ modelId: provider.modelId, accountScope, filters, chunkPks, onDemandReadsTablePresent }, 0);
      const plan = db.query(`EXPLAIN QUERY PLAN ${page.sql}`).all(...page.params) as Array<{ detail: string }>;
      console.log(JSON.stringify({ liveScope: true, filterKeys: Object.keys(filters).sort(), onDemandReadsTablePresent, plan: plan.map(row => row.detail) }));
    } finally { db.close(); }
  }
  let reads: Array<{ site: string; sentAt: number }> = [];
  setReadPoolObserverForTests((dbPath, read) => { if (dbPath === store.dbPath) reads.push({ site: poolSqlSite(read.sql), sentAt: performance.now() }); }, { snapshots: true });
  for (let trial = 1; trial <= trials; trial++) {
    reads = [];
    const started = performance.now();
    const lane = await store.vectorSearchLane(query, provider, maxResults, accountScope, filters, Date.now() + deadlineMs);
    const ended = performance.now();
    const sites = new Map<string, { reads: number; ms: number; maxMs: number }>();
    reads.forEach((read, at) => {
      const ms = (reads[at + 1]?.sentAt ?? ended) - read.sentAt;
      const entry = sites.get(read.site) ?? { reads: 0, ms: 0, maxMs: 0 };
      entry.reads += 1; entry.ms += ms; entry.maxMs = Math.max(entry.maxMs, ms);
      sites.set(read.site, entry);
    });
    console.log(JSON.stringify({
      trial, corpus, liveScope: filters !== undefined, laneMs: Math.round(ended - started), rows: lane.rows.length,
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
