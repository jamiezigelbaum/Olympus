// The real vector lane on one store of an offline data-root copy, timed read
// by read. Counts, ids and timings only: no item text is printed.
//   bun eval/vector-lane-one-store.ts --data-root <copy> --corpus internal.dropbox.files \
//     --query-file <file with the question> [--trials 3] [--max-results 24] [--deadline-ms 54000]
//     --registry <connected handle registry> [--source dropbox.files] [--account personal] | --no-live-scope
// By default it searches with the account scope and filters the live Ask
// passes (the source's approved folder scope, as the engine builds them),
// and prints the re-score page's EXPLAIN QUERY PLAN with them: a speed
// number taken without the owner's real scope does not count (15 Nov).
// --no-live-scope searches the whole store, for comparison only.
// --lane keyword times the keyword lane's two searches (plain, then content
// only) instead, and prints the query plan of its three slowest read sites.
// Plans name tables and indexes only, never a searched value.
// --writer runs a writer on the copy's store during the trials (a no-op
// update in its own transaction every 50 ms, from another thread), so a
// read is timed while the WAL grows, as it does during ingest. Each trial
// prints the read pool's worker count and the process RSS, so the memory
// of the re-score's side readers shows beside its time.
// Read-only. Each read's time is measured from when it is sent to when the
// next read of that store is sent; the scan's reads run one at a time.
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.ts';
import { connectorStoreCurrentEmbeddingPageQuery, type ConnectorStoreSearchFilters } from '../src/workers/connector-store/local-index.ts';
import { readPoolDiagnostics, setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
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
  const keywordLane = values.get('lane') === 'keyword';
  const provider = embedding.embeddingFor(store.trustDomain);
  if (!provider && !keywordLane) throw new Error('No embedding provider for that store.');
  let accountScope: string | undefined;
  let filters: ConnectorStoreSearchFilters | undefined;
  if (!rest.includes('--no-live-scope')) {
    const registryPath = values.get('registry');
    if (!registryPath) throw new Error('--registry is required (or --no-live-scope, for a comparison that does not count).');
    const approval = new FileSourceScopeAuthority({ registryPath }).snapshot(values.get('source') ?? 'dropbox.files');
    const scope = fileSourceScopeMetadataFilters(approval);
    if (!scope.allowed) throw new Error(`The source scope is not approved (${approval.status}).`);
    filters = scope.filters;
    accountScope = values.get('account') ?? 'personal';
    if (provider) {
    const db = new Database(store.dbPath, { readonly: true, create: false, strict: true });
    try {
      const onDemandReadsTablePresent = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'on_demand_item_reads'").get());
      const chunkPks = (db.query('SELECT chunk_pk FROM chunk_embeddings WHERE model_id = ? ORDER BY chunk_pk LIMIT 256').all(provider.modelId) as Array<{ chunk_pk: number }>).map(row => row.chunk_pk);
      const page = connectorStoreCurrentEmbeddingPageQuery({ modelId: provider.modelId, accountScope, filters, chunkPks, onDemandReadsTablePresent }, 0);
      const plan = db.query(`EXPLAIN QUERY PLAN ${page.sql}`).all(...page.params) as Array<{ detail: string }>;
      console.log(JSON.stringify({ liveScope: true, filterKeys: Object.keys(filters).sort(), onDemandReadsTablePresent, rescorePlan: plan.map(row => row.detail) }));
    } finally { db.close(); }
    }
  }
  const writer = rest.includes('--writer') ? new Worker(URL.createObjectURL(new Blob([`
    const { Database } = require('bun:sqlite');
    const db = new Database(${JSON.stringify(store.dbPath)});
    db.exec('PRAGMA busy_timeout = 5000');
    const touch = db.query('UPDATE items SET tombstoned = tombstoned WHERE item_pk = (SELECT max(item_pk) FROM items)');
    let writes = 0;
    setInterval(() => { db.transaction(() => touch.run())(); writes += 1; }, 50);
    self.onmessage = () => { postMessage(writes); db.close(); };
  `], { type: 'application/javascript' }))) : undefined;
  let reads: Array<{ site: string; sentAt: number }> = [];
  const examples = new Map<string, { sql: string; params: unknown }>();
  const slowest = new Map<string, number>();
  setReadPoolObserverForTests((dbPath, read) => {
    if (dbPath !== store.dbPath) return;
    const site = poolSqlSite(read.sql);
    if (!examples.has(site)) examples.set(site, { sql: read.sql, params: read.params });
    reads.push({ site, sentAt: performance.now() });
  }, { snapshots: true });
  for (let trial = 1; trial <= trials; trial++) {
    reads = [];
    const started = performance.now();
    const deadlineAtMs = Date.now() + deadlineMs;
    const lane: { rows: Array<{ sourceItem: { localItemId: string } }>; skippedReason?: string } = keywordLane
      ? await (async () => {
        const plain = await store.searchItemsDetailedOffThread(query, 50, accountScope, filters, {}, { deadlineAtMs });
        const content = await store.searchItemsDetailedOffThread(query, 50, accountScope, filters, { contentOnly: true }, { deadlineAtMs });
        return { rows: [...plain.rows, ...content.rows] };
      })()
      : await store.vectorSearchLane(query, provider!, maxResults, accountScope, filters, deadlineAtMs);
    const ended = performance.now();
    const sites = new Map<string, { reads: number; ms: number; maxMs: number }>();
    reads.forEach((read, at) => {
      const ms = (reads[at + 1]?.sentAt ?? ended) - read.sentAt;
      const entry = sites.get(read.site) ?? { reads: 0, ms: 0, maxMs: 0 };
      entry.reads += 1; entry.ms += ms; entry.maxMs = Math.max(entry.maxMs, ms);
      sites.set(read.site, entry);
      slowest.set(read.site, Math.max(slowest.get(read.site) ?? 0, ms));
    });
    console.log(JSON.stringify({
      trial, corpus, lane: keywordLane ? 'keyword' : 'vector', poolThreads: readPoolDiagnostics().threads, rssMb: Math.round(process.memoryUsage().rss / 1e6), liveScope: filters !== undefined, laneMs: Math.round(ended - started), rows: lane.rows.length,
      ...(lane.skippedReason ? { skippedReason: lane.skippedReason } : {}),
      itemIds: lane.rows.map(row => row.sourceItem.localItemId),
      sites: [...sites].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6)
        .map(([site, entry]) => ({ site: site.slice(0, 60), reads: entry.reads, ms: Math.round(entry.ms), maxMs: Math.round(entry.maxMs) })),
    }));
  }
  setReadPoolObserverForTests();
  if (keywordLane) {
    const db = new Database(store.dbPath, { readonly: true, create: false, strict: true });
    try {
      for (const [site, ms] of [...slowest].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        const example = examples.get(site)!;
        const plan = db.query(`EXPLAIN QUERY PLAN ${example.sql}`).all(...(example.params as Array<string | number | null>)) as Array<{ detail: string }>;
        console.log(JSON.stringify({ site: site.slice(0, 60), maxMs: Math.round(ms), plan: plan.map(row => row.detail) }));
      }
    } finally { db.close(); }
  }
  if (writer) {
    const writes = await new Promise<number>(resolve => { writer.onmessage = event => resolve(event.data as number); writer.postMessage('stop'); });
    writer.terminate();
    console.log(JSON.stringify({ writer: true, writes }));
  }
  for (const opened_ of opened.stores) opened_.close();
}

await main();
