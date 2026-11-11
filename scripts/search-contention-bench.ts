#!/usr/bin/env bun
/** Synthetic #1305 gate. Stores/logs MUST be outside the checkout.
 * bun scripts/search-contention-bench.ts seed --dir /tmp/olympus-gate5-data --items 2000000
 * bun scripts/search-contention-bench.ts run --dir /tmp/olympus-gate5-data --source /tmp/olympus-gate5-data/src-main --label main --writer off --asks 1 --keep yes
 * A source directory is a read-only git-archive snapshot, not a checkout/worktree. Put snapshots
 * under --dir (src-<label>) so one directory holds everything the gate wrote.
 * run, warm and calibrate delete --dir when they exit, snapshots included; pass --keep yes on
 * every run but the last.
 * Prints exactly one JSON line per measured Ask; appends it to --report (Markdown).
 *
 * Seed shapes (#1305): every chunk carries a --dim (default 768) float vector, so the exact-vector
 * scan reads real bytes; every store holds --sync-runs (default 200000) tier-move runs and a few real
 * syncs, as Sparta's stores do. Gate bound (1.5): with the writer on, each Ask's request-thread
 * SQLite (main_thread_sql.total_ms) is at most 2,000 ms and no statement runs 250 ms or more; a run
 * that breaks it exits non-zero. The seed also writes a tier ledger (every item routed, one in ten
 * held from embedding, one in fifty moved), and a run routes through the visibility gate over it. Defined in docs/ENGINEERING_PROCESS.md, "Busy-store gate".
 */
import { Database } from 'bun:sqlite';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Map<string, string>();
for (let i = 3; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const command = process.argv[2];
const dir = resolve(args.get('dir') ?? '/tmp/olympus-gate5-data');
if (!dir.startsWith('/tmp/olympus-gate5-')) throw new Error('Synthetic stores must be under /tmp/olympus-gate5-*');
mkdirSync(dir, { recursive: true });
if (!realpathSync(dir).startsWith('/tmp/olympus-gate5-')) throw new Error('No symlinks to live stores');
// A gate's stores are gigabytes; a runner that keeps them fills its disk. Only seed keeps them by default.
if (command !== 'seed' && args.get('keep') !== 'yes') {
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
}
// Isolate all incidental library settings/cache access as well as the stores.
process.env.HOME = join(dir, 'home');
mkdirSync(process.env.HOME, { recursive: true });
const source = resolve(args.get('source') ?? '.');
const mod = async (path: string): Promise<any> => import(pathToFileURL(join(source, path)).href);
const { LocalConnectorStore, createConnectorStoreCorpusAdapter, defineConnectorCorpus } = await mod('src/workers/connector-store/local-index.ts');
const pool = await mod('src/workers/connector-store/off-thread-reads.ts');
const { routeSourceIndexSearch } = await mod('src/core/source-index/router.ts');
const { buildSourceIndexCorpusRegistry } = await mod('src/core/source-index/corpus.ts');
const fixtures = await mod('test/helpers/tier-fixtures.ts');
const report = args.get('report') ?? join(tmpdir(), 'search-contention-result.md');
const formulations = ['orchard invoice budget', 'orchard lawyer contract', 'invoice budget report'];
// The vector width the seed wrote (seed.json); older seeds had 4.
const seedPath = join(dir, 'seed.json');
const ledgerPath = join(dir, 'tier-ledger.sqlite');
const dimension = command === 'seed'
  ? Number(args.get('dim') ?? 768)
  : existsSync(seedPath) ? (JSON.parse(readFileSync(seedPath, 'utf8')) as { dim: number }).dim : 4;
const unitVector = () => Array.from({ length: dimension }, (_, i) => (i === 0 ? 1 : 0));
const provider = { provider: 'openai-compatible', modelId: 'synthetic-fixed-v1', backend: 'local', dimension,
  epochId: 'synthetic-fixed-v1', configHash: 'synthetic', async embed(inputs: unknown[]) { return inputs.map(unitVector); } };
// The gate's bound on one Ask's synchronous SQLite on the request thread.
const MAIN_THREAD_SQL_BOUND_MS = 2_000;
const MAIN_THREAD_SQL_STATEMENT_BOUND_MS = 250;
const rss = () => process.memoryUsage().rss / 1048576;
const diagnostic = () => pool.readPoolDiagnostics?.() ?? { starts: 0, terminations: 0, restarts: 0, opens: 0, openMs: 0, threads: 0, stores: {} };
function readManifest(): Array<{ path: string; items: number; bytes: number }> {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Array<{ path: string; items: number; bytes: number }>;
  for (const store of manifest) {
    if (!resolve(store.path).startsWith(`${dir}/`) || !realpathSync(store.path).startsWith(`${realpathSync(dir)}/`)) {
      throw new Error('Manifest store escapes the synthetic directory');
    }
  }
  return manifest;
}

if (command === 'seed') {
  if (existsSync(join(dir, 'manifest.json'))) throw new Error('Already seeded; reuse the manifest or choose a fresh /tmp/olympus-gate5-* directory');
  const started = performance.now();
  const count = Number(args.get('stores') ?? 11);
  const maxItems = Number(args.get('items') ?? 2_000_000);
  const syncRuns = Number(args.get('sync-runs') ?? 200_000);
  writeFileSync(seedPath, JSON.stringify({ dim: dimension, syncRuns, ledger: true }));
  const f = fixtures.openTierFixture(join(dir, 'template'), { embed: false });
  const text = 'Synthetic orchard invoice budget lawyer contract report. '.repeat(4);
  await f.set.sync(fixtures.fixtureConnector(() => [{ id: 'template', name: 'Synthetic orchard invoice', text }]), { fetchContent: true, placement: fixtures.FIXTURE_PLACEMENT });
  const copy = f.stores.internal.exportItemCopy(fixtures.identityOf('template'));
  copy.vectorAuthorities = [{ ...provider }];
  copy.vectors = copy.chunks.map((c: any) => ({ chunkIndex: c.chunkIndex, modelId: provider.modelId, contentHash: c.embeddingInputHash,
    embedding: new Uint8Array(new Float32Array(unitVector()).buffer) }));
  f.stores.internal.importItemCopy(copy, { trustTier: 'S3', syncConnectorId: 'synthetic', vectorProvider: provider });
  const templateIdentity = fixtures.identityOf('template');
  f.close();
  // The tier ledger the search's visibility gate reads, as on a real install:
  // every item routed, with its copy in its store; one in ten held from
  // embedding until judged, one in fifty moved (its copy here superseded).
  cpSync(join(dir, 'template', 'fixture-secure-store.tier-ledger.sqlite'), ledgerPath);
  const ledgerDb = new Database(ledgerPath);
  ledgerDb.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;');
  const ledgerColumns = (table: string) => (ledgerDb.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
  const templateWhere = `provider = '${templateIdentity.provider}' AND account_scope = '${templateIdentity.accountScope}' AND provider_item_id = '${templateIdentity.providerItemId}'`;
  function seedLedger(store: number, items: number) {
    const q = (name: string) => `"${name}"`;
    const itemCols = ledgerColumns('tier_items');
    const copyCols = ledgerColumns('tier_copies');
    const itemExpr = itemCols.map(c => c === 'provider_item_id' ? `'synthetic-${store}-'||n` : `t.${q(c)}`);
    const copyExpr = (state: string) => copyCols.map(c => c === 'provider_item_id' ? `'synthetic-${store}-'||n`
      : c === 'corpus_id' ? (state === 'moved' ? "'secure_local.synthetic'" : `'internal.synthetic.${store}'`)
      : c === 'copy_state' ? (state === 'superseded' ? "CASE WHEN n % 50 = 0 THEN 'superseded' ELSE 'current' END" : "'current'")
      : c === 'embed_hold' ? (state === 'superseded' ? 'CASE WHEN n % 10 = 0 THEN 1 ELSE 0 END' : '0')
      : `t.${q(c)}`);
    for (let offset = 1; offset < items; offset += 50_000) {
      const end = Math.min(items, offset + 50_000);
      const numbers = `WITH RECURSIVE seq(n) AS (SELECT ${offset} UNION ALL SELECT n+1 FROM seq WHERE n+1<${end})`;
      ledgerDb.transaction(() => {
        ledgerDb.exec(`${numbers} INSERT INTO tier_items (${itemCols.map(q)}) SELECT ${itemExpr} FROM seq CROSS JOIN (SELECT * FROM tier_items WHERE ${templateWhere}) t`);
        ledgerDb.exec(`${numbers} INSERT INTO tier_copies (${copyCols.map(q)}) SELECT ${copyExpr('superseded')} FROM seq CROSS JOIN (SELECT * FROM tier_copies WHERE ${templateWhere} LIMIT 1) t`);
        ledgerDb.exec(`${numbers} INSERT INTO tier_copies (${copyCols.map(q)}) SELECT ${copyExpr('moved')} FROM seq CROSS JOIN (SELECT * FROM tier_copies WHERE ${templateWhere} LIMIT 1) t WHERE n % 50 = 0`);
      })();
    }
  }
  const template = fixtures.storePaths(join(dir, 'template')).internal;
  const manifest: any[] = [];
  for (let i = 0; i < count; i++) {
    const path = join(dir, `store-${i}.sqlite`);
    const items = Math.round(maxItems * (0.1 + 0.9 * (i / Math.max(1, count - 1)) ** 2));
    cpSync(template, path);
    const db = new Database(path);
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;');
    // Bulk SQL copies of the real imported item/chunk. No mock search or substitute index.
    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
    const quote = (name: string) => `"${name}"`;
    const itemColumns = columns('items');
    // Ids unique across stores, so each item has its own row and copy in the shared ledger.
    const expressions = itemColumns.map(c => c === 'item_pk' ? 'n+1' : c === 'local_item_id' ? `'personal:synthetic-${i}-'||n` : c === 'provider_item_id' ? `'synthetic-${i}-'||n` : `t.${quote(c)}`);
    const chunkColumns = columns('chunks');
    const chunks = chunkColumns.map(c => c === 'chunk_pk' || c === 'item_pk' ? 'n+1' : `t.${quote(c)}`);
    const vectorColumns = columns('chunk_embeddings');
    const vectors = vectorColumns.map(c => c === 'chunk_pk' || c === 'item_pk' ? 'n+1' : `t.${quote(c)}`);
    for (let offset = 1; offset < items; offset += 25_000) {
      const end = Math.min(items, offset + 25_000);
      const numbers = `WITH RECURSIVE seq(n) AS (SELECT ${offset} UNION ALL SELECT n+1 FROM seq WHERE n+1<${end})`;
      db.transaction(() => {
        db.exec(`${numbers} INSERT INTO items (${itemColumns.map(quote)}) SELECT ${expressions} FROM seq CROSS JOIN (SELECT * FROM items WHERE item_pk=1) t`);
        db.exec(`${numbers} INSERT INTO chunks (${chunkColumns.map(quote)}) SELECT ${chunks} FROM seq CROSS JOIN (SELECT * FROM chunks WHERE item_pk=1 LIMIT 1) t`);
        db.exec(`${numbers} INSERT INTO chunk_embeddings (${vectorColumns.map(quote)}) SELECT ${vectors} FROM seq CROSS JOIN (SELECT * FROM chunk_embeddings WHERE item_pk=1 LIMIT 1) t`);
        db.exec(`INSERT INTO connector_store_fts(title,bounded_text,item_pk,chunk_pk) SELECT i.title,c.bounded_text,i.item_pk,c.chunk_pk FROM items i JOIN chunks c USING(item_pk) WHERE i.item_pk>${offset} AND i.item_pk<=${end}`);
      })();
      if (performance.now() - started > 25 * 60_000) throw new Error('25 minute seed budget exhausted; existing stores retained');
    }
    db.exec('INSERT OR IGNORE INTO connector_store_fts_rows(fts_rowid,item_pk,chunk_pk) SELECT rowid,item_pk,chunk_pk FROM connector_store_fts');
    // Run history: every tier move writes a run, so a busy store holds far more of them than real syncs.
    const runColumns = columns('sync_runs');
    const runs = runColumns.map(c => c === 'sync_run_id' ? "'synthetic-run-'||n"
      : c === 'connector_id' ? "CASE WHEN n % 1000 = 0 THEN 'synthetic' ELSE 'olympus_tier_move' END"
      : c === 'status' ? "'completed'" : c === 'cursor' || c === 'audit_receipt_sha256' || c === 'error' ? 'NULL'
      : c === 'started_at' || c === 'completed_at' ? "strftime('%Y-%m-%dT%H:%M:%fZ', 1762000000 + n, 'unixepoch')" : `t.${quote(c)}`);
    for (let offset = 0; offset < syncRuns; offset += 50_000) {
      const end = Math.min(syncRuns, offset + 50_000);
      db.exec(`WITH RECURSIVE seq(n) AS (SELECT ${offset} UNION ALL SELECT n+1 FROM seq WHERE n+1<${end}) INSERT INTO sync_runs (${runColumns.map(quote)}) SELECT ${runs} FROM seq CROSS JOIN (SELECT * FROM sync_runs LIMIT 1) t`);
    }
    seedLedger(i, items);
    // Fixed vectors on the imported template suffice to exercise the real hybrid path.
    db.exec("INSERT INTO connector_store_fts(connector_store_fts) VALUES('optimize'); PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    ledgerDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    manifest.push({ path, items, bytes: statSync(path).size });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    console.error(`seeded ${i+1}/${count}: ${items} items`);
  }
  ledgerDb.exec('ANALYZE'); ledgerDb.close();
  const row = { phase: 'seed', stores: manifest.length, items: manifest.reduce((n,s) => n+s.items, 0), bytes: manifest.reduce((n,s) => n+s.bytes, 0), ms: performance.now()-started };
  console.log(JSON.stringify(row));
  appendFileSync(report, `\nSeed receipt: ${JSON.stringify(row)}\n`);
} else if (command === 'warm') {
  const manifest = readManifest();
  const count = Number(args.get('stores') ?? 11);
  const before = rss(); const beforePool = diagnostic();
  const t = performance.now();
  const paths = Array.from({ length: count }, (_, i) => {
    if (manifest[i]) return manifest[i]!.path;
    const path = join(dir, `memory-store-${i}.sqlite`);
    // Small real schema copies suffice: worker/runtime plus SQLite cache, not corpus bytes, dominate RSS.
    if (!existsSync(path)) cpSync(join(dir, 'template', 'fixture-internal-store.sqlite'), path);
    return path;
  });
  await Promise.all(paths.map(path => pool.readOnPool(path, { sql: 'SELECT COUNT(*) AS n FROM items', params: [], mode: 'get' })));
  const row = { phase: 'warm', label: args.get('label') ?? 'current', stores: count, wall_ms: performance.now()-t,
    rss_before_mb: before, rss_after_mb: rss(), rss_process_high_water_mb: process.resourceUsage().maxRSS/1024,
    pool_before: beforePool, pool_after: diagnostic(), load_1m: loadavg()[0] };
  console.log(JSON.stringify(row)); appendFileSync(report, `\nMemory receipt:\n\n\`\`\`json\n${JSON.stringify(row)}\n\`\`\`\n`);
  pool.shutdownReadPool?.();
} else if (command === 'run' || command === 'calibrate') {
  const manifest = readManifest();
  const selected = args.has('store-index') ? [manifest[Number(args.get('store-index'))]!] : args.has('stores') ? manifest.slice(0, Number(args.get('stores'))) : manifest;
  const openStarted = performance.now();
  const stores = selected.map((s,i) => new LocalConnectorStore({ dbPath: s.path, corpusId: `internal.synthetic.${i}`, family: 'file', trustDomain: 'internal', tierLedger: null, readOnly: true }));
  const mainOpenMs = performance.now() - openStarted;
  if (command === 'calibrate') {
    const timings = stores.map((s,i) => {
      const t = performance.now(); const found = s.searchItemsDetailed(formulations[0], 20);
      return { store: i, items: selected[i]!.items, ms: performance.now()-t, results: found.rows.length };
    });
    const row = { phase: 'calibrate', timings, rss_mb: rss() };
    console.log(JSON.stringify(row)); appendFileSync(report, `\nCalibration:\n\n\`\`\`json\n${JSON.stringify(row)}\n\`\`\`\n`);
  } else {
    const definitions = stores.map((s: any) => defineConnectorCorpus({ corpusId: s.corpusId, family: 'file', trustDomain: 'internal', activationMode: 'hybrid_primary' }));
    // The search's visibility gate over the seeded tier ledger, as the product wires it.
    const seeded = JSON.parse(readFileSync(seedPath, 'utf8')) as { ledger?: boolean };
    let visibilityGate: any;
    let gateLedger: any;
    if (seeded.ledger && existsSync(ledgerPath)) {
      const { TierLedger } = await mod('src/workers/classification/tier-ledger.ts');
      const { createTierVisibilityGate } = await mod('src/workers/connector-store/tier-visibility.ts');
      gateLedger = new TierLedger({ dbPath: ledgerPath, readOnly: true });
      visibilityGate = createTierVisibilityGate(() => [{ ledger: gateLedger, corpusIds: new Set(stores.map((s: any) => s.corpusId)) }]);
    }
    const registry = buildSourceIndexCorpusRegistry(definitions);
    const keywordReads: Array<{ store: number; query: string; run_ms: number; results: number }> = [];
    stores.forEach((store: any, i: number) => {
      const original = store.searchItemsDetailed.bind(store);
      store.searchItemsDetailed = (...params: any[]) => {
        const t = performance.now(); const result = original(...params);
        keywordReads.push({ store: i, query: params[0], run_ms: performance.now()-t, results: result.rows.length });
        return result;
      };
    });
    const underlying = stores.map((s: any) => createConnectorStoreCorpusAdapter({ store: s, embeddingProvider: provider }));
    const asks = Number(args.get('asks') ?? 1);
    let writer: any;
    let imports = 0; let moves = 0; let stopped = false; let writerError: string | undefined;
    // Longest single writer call of each kind, to place any request-thread freeze.
    const writerMax = { import_ms: 0, move_ms: 0 };
    let writerTask: Promise<void> | undefined;
    let startWriter: (() => Promise<void>) | undefined;
    if (args.get('writer') === 'on') {
      // Actual import and tier-move operations on this JavaScript thread, into the first measured store.
      const writerRun = crypto.randomUUID();
      const writerDir = join(dir, `writer-${writerRun}`); mkdirSync(writerDir, { recursive: true });
      // Preserve the synthetic ledger identity referenced by the seeded store.
      cpSync(join(dir, 'template', 'fixture-secure-store.tier-ledger.sqlite'), join(writerDir, 'fixture-secure-store.tier-ledger.sqlite'));
      writer = fixtures.openTierFixture(writerDir, { embed: false, paths: { ...fixtures.storePaths(writerDir), internal: selected[0]!.path } });
      for (const store of writer.set.openStores()) store.bindTierSet(writer.ledger);
      const copy = writer.stores.internal.exportItemCopy(fixtures.identityOf('template'));
      const { classifyItemTiers } = await mod('src/workers/classification/tier-classifier.ts');
      const { moveTieredItem } = await mod('src/workers/connector-store/tier-move.ts');
      const low = classifyItemTiers({ signals: { title: 'Synthetic' }, text: 'Synthetic ordinary note.' });
      const high = { ...low, metadataTier: 'secure', contentTier: 'secure' };
      startWriter = async () => {
        try {
          while (!stopped) {
            for (let j=0; j<5; j++) {
              const identity = fixtures.identityOf(`writer-${writerRun}-${imports}`);
              const ti = performance.now();
              writer.stores.internal.importItemCopy({ ...copy, identity, columns: { ...copy.columns, provider_item_id: identity.providerItemId, local_item_id: identity.localItemId } }, { trustTier: 'S3', syncConnectorId: 'synthetic-writer' });
              imports++;
              writer.ledger.recordRoutedPlacement(identity, low, writer.set.placementFor(low));
              writerMax.import_ms = Math.max(writerMax.import_ms, performance.now() - ti);
              const tm = performance.now();
              await moveTieredItem({ set: writer.set, identity, target: high }); moves++;
              writerMax.move_ms = Math.max(writerMax.move_ms, performance.now() - tm);
            }
            await new Promise<void>(r => setTimeout(r, 10));
          }
        } catch (e) { writerError=String(e); }
      };
    }
    let boundFailures = 0;
    for (let ask=1; ask<=asks; ask++) {
      const before = rss(); const loadStart=loadavg()[0]; const beforePool=diagnostic();
      const importStart=imports; const moveStart=moves;
      // The sampler doubles as a heartbeat: lag past its 20 ms period is time the request thread did not turn.
      let peak=before; const lags: number[] = []; let beat=performance.now();
      const sampler=setInterval(() => { const now=performance.now(); lags.push(Math.max(0, now-beat-20)); beat=now; peak=Math.max(peak,rss()); }, 20);
      writerMax.import_ms = 0; writerMax.move_ms = 0;
      keywordReads.length = 0;
      const laneRecords: any[]=[];
      const t=performance.now();
      if (!writerTask && startWriter) writerTask = startWriter();
      const results = await Promise.all(formulations.map(async (query, ordinal) => {
        const adapters: any = {};
        for (const [i, adapter] of underlying.entries()) {
          const wrapped = Object.assign(async (request: any) => {
            const start=performance.now();
            try { const result=await adapter(request); laneRecords.push({ formulation: ordinal+1, store: i, adapter_ms: performance.now()-start, results: result.hits.length }); return result; }
            catch (error) { laneRecords.push({ formulation: ordinal+1, store: i, adapter_ms: performance.now()-start, error: String(error) }); throw error; }
          }, adapter);
          adapters[stores[i].corpusId]=wrapped;
        }
        const traceModule = existsSync(join(source,'src/workers/source-index/answer-latency-trace.ts')) ? await mod('src/workers/source-index/answer-latency-trace.ts') : undefined;
        const trace=traceModule?.createSourceAnswerTrace?.();
        const start=performance.now();
        const run=() => routeSourceIndexSearch({ registry, adapters, request: { query, maxResults: 220, context: { allowedTrustDomains: ['internal'], allowCloudQueries: false } }, ...(args.has('budget-ms') ? { laneTimeoutMs: Number(args.get('budget-ms')) } : {}), ...(visibilityGate ? { visibilityGate } : {}) });
        const result= traceModule?.observeSourceAnswerRoutedQuery ? await traceModule.runWithSourceAnswerTrace(trace, () => traceModule.observeSourceAnswerRetrievalAttempt('hybrid', () => traceModule.observeSourceAnswerRoutedQuery(ordinal+1, run))) : await run();
        return { ordinal: ordinal+1, wall_ms: performance.now()-start, timed_out: result.skippedCorpora.filter((s:any)=>s.reason==='lane_timeout').length, completed: result.searchedCorpora.length,
          completed_with_results: new Set(result.hits.map((h:any)=>h.corpusId)).size, hit_fingerprints: Object.fromEntries(stores.map((s:any) => [s.corpusId, Bun.hash(result.hits.filter((h:any)=>h.corpusId===s.corpusId).map((h:any)=>h.sourceItem.localItemId).sort().join('\n')).toString(16)])),
          lanes: result.corpusTimings, lane_audits: result.laneAudits, trace: trace ? traceModule.snapshotSourceAnswerTrace(trace).retrievalAttempts : undefined,
          main_thread_sql: trace ? traceModule.snapshotSourceAnswerTrace(trace).mainThreadSql : undefined };
      }));
      clearInterval(sampler); peak=Math.max(peak,rss());
      const afterPool=diagnostic();
      const perLane = results.flatMap(r => (r.lanes ?? []).map((lane: any) => {
        const i = stores.findIndex((s: any) => s.corpusId === lane.corpusId);
        const traced = r.trace?.flatMap((a: any) => a.queries).flatMap((q: any) => q.corpus_timings).find((l: any) => l.corpus_id === lane.corpusId)?.pool;
        return { formulation: r.ordinal, store: i, outcome: lane.outcome, elapsed_ms: lane.elapsedMs,
          queue_ms: traced?.queue_wait_ms ?? 0, run_ms: traced?.run_ms ?? keywordReads.filter(k => k.store === i && k.query === formulations[r.ordinal-1]).reduce((n,k) => n+k.run_ms,0),
          timing_kind: traced ? 'pool-statements' : 'on-thread-search', pool: traced };
      }));
      // The three formulations run at once, as one Ask's do; their request-thread SQLite adds up.
      const traced = results.flatMap(r => r.main_thread_sql ? [r.main_thread_sql] : []);
      const mainThreadSql = traced.length === 0 ? undefined : {
        statements: traced.reduce((n, m) => n + m.statements, 0),
        total_ms: Math.round(traced.reduce((n, m) => n + m.total_ms, 0)),
        max_ms: Math.round(Math.max(0, ...traced.map(m => m.max_ms))),
        slow: traced.flatMap(m => m.slow).sort((a: any, b: any) => b.ms - a.ms).slice(0, 20),
        by_site: traced.flatMap(m => m.by_site ?? []).sort((a: any, b: any) => b.ms - a.ms).slice(0, 10),
      };
      const bound = mainThreadSql === undefined ? undefined : {
        limit_ms: MAIN_THREAD_SQL_BOUND_MS, statement_limit_ms: MAIN_THREAD_SQL_STATEMENT_BOUND_MS,
        pass: mainThreadSql.total_ms <= MAIN_THREAD_SQL_BOUND_MS && mainThreadSql.max_ms < MAIN_THREAD_SQL_STATEMENT_BOUND_MS,
      };
      if (bound && !bound.pass) boundFailures += 1;
      const row = { label: args.get('label')??'current', source, main_thread_sql: mainThreadSql, main_thread_bound: bound, writer: args.get('writer')??'off', ask, stores: stores.length, formulations: 3, items: selected.reduce((n,s)=>n+s.items,0),
        budget_ms: args.get('budget-ms')??'router-default', wall_ms: performance.now()-t, lanes_timed_out: results.reduce((n,r)=>n+r.timed_out,0), lanes_completed_with_results: results.reduce((n,r)=>n+r.completed_with_results,0),
        main_store_opens: stores.length, main_store_open_ms: mainOpenMs, pool_before: beforePool, pool_after: afterPool,
        rss_before_mb: before, rss_after_mb: rss(), rss_peak_mb: Math.max(peak, rss()), rss_process_high_water_mb: process.resourceUsage().maxRSS/1024, load_1m_start: loadStart, load_1m_end: loadavg()[0], imports: imports-importStart, tier_moves: moves-moveStart,
        freeze_ms: { max: Math.round(Math.max(0, ...lags)), over_1s: lags.filter(l => l > 1000).length, total_over_1s: Math.round(lags.filter(l => l > 1000).reduce((n,l)=>n+l,0)) }, writer_max_call_ms: { import: Math.round(writerMax.import_ms), move: Math.round(writerMax.move_ms) }, writer_error: writerError, results, per_lane: perLane, lane_records: laneRecords, on_thread_keyword_reads: keywordReads };
      console.log(JSON.stringify(row));
      appendFileSync(report, `\n## ${row.label}, writer ${row.writer}, Ask ${ask}\n\n${row.lanes_completed_with_results}/${stores.length * 3} lanes with results; ${row.lanes_timed_out} timed out; ${(row.wall_ms/1000).toFixed(2)} s. Request-thread SQLite ${mainThreadSql ? `${mainThreadSql.total_ms} ms, longest ${mainThreadSql.max_ms} ms (${bound!.pass ? 'within' : 'OVER'} the gate bound)` : 'not traced by this build'}. RSS ${before.toFixed(1)} → ${row.rss_after_mb.toFixed(1)} MiB; peak ${peak.toFixed(1)} MiB. Imports ${row.imports}; tier moves ${row.tier_moves}.\n\n<details><summary>Full numeric receipt</summary>\n\n\`\`\`json\n${JSON.stringify(row)}\n\`\`\`\n</details>\n`);
    }
    stopped=true; await writerTask; writer?.close(); gateLedger?.close();
    if (writerError) throw new Error(`Writer failed: ${writerError}`);
    if (args.get('writer') === 'on' && (imports === 0 || moves === 0)) throw new Error('Writer did not import and move any items');
    if (boundFailures > 0) {
      stores.forEach((s:any)=>s.close()); pool.shutdownReadPool?.();
      throw new Error(`${boundFailures} Ask(s) broke the request-thread SQLite bound`);
    }
  }
  stores.forEach((s:any)=>s.close()); pool.shutdownReadPool?.();
} else throw new Error('Use seed, calibrate, or run');
