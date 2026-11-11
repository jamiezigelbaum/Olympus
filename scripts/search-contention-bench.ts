#!/usr/bin/env bun
/** Synthetic #1305 gate. Stores/logs MUST be outside the checkout.
 * bun scripts/search-contention-bench.ts seed --dir /tmp/olympus-gate5-data --items 2000000
 * bun scripts/search-contention-bench.ts run --dir /tmp/olympus-gate5-data --source /tmp/olympus-gate5-main --label main --writer off --asks 1
 * A source directory is a read-only git-archive snapshot, not a checkout/worktree.
 * Prints exactly one JSON line per measured Ask; appends it to --report (Markdown).
 */
import { Database } from 'bun:sqlite';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
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
const provider = { provider: 'openai-compatible', modelId: 'synthetic-fixed-v1', backend: 'local', dimension: 4,
  epochId: 'synthetic-fixed-v1', configHash: 'synthetic', async embed(inputs: unknown[]) { return inputs.map(() => [1, 0, 0, 0]); } };
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
  const f = fixtures.openTierFixture(join(dir, 'template'), { embed: false });
  const text = 'Synthetic orchard invoice budget lawyer contract report. '.repeat(4);
  await f.set.sync(fixtures.fixtureConnector(() => [{ id: 'template', name: 'Synthetic orchard invoice', text }]), { fetchContent: true, placement: fixtures.FIXTURE_PLACEMENT });
  const copy = f.stores.internal.exportItemCopy(fixtures.identityOf('template'));
  copy.vectorAuthorities = [{ ...provider }];
  copy.vectors = copy.chunks.map((c: any) => ({ chunkIndex: c.chunkIndex, modelId: provider.modelId, contentHash: c.embeddingInputHash,
    embedding: new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer) }));
  f.stores.internal.importItemCopy(copy, { trustTier: 'S3', syncConnectorId: 'synthetic', vectorProvider: provider });
  f.close();
  const template = fixtures.storePaths(join(dir, 'template')).internal;
  const manifest: any[] = [];
  for (let i = 0; i < count; i++) {
    const path = join(dir, `store-${i}.sqlite`);
    const items = Math.round(maxItems * (0.1 + 0.9 * (i / Math.max(1, count - 1)) ** 2));
    cpSync(template, path);
    const db = new Database(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;');
    // Bulk SQL copies of the real imported item/chunk. No mock search or substitute index.
    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
    const quote = (name: string) => `"${name}"`;
    const itemColumns = columns('items');
    const expressions = itemColumns.map(c => c === 'item_pk' ? 'n+1' : c === 'local_item_id' ? "'personal:synthetic-'||n" : c === 'provider_item_id' ? "'synthetic-'||n" : `t.${quote(c)}`);
    const chunkColumns = columns('chunks');
    const chunks = chunkColumns.map(c => c === 'chunk_pk' || c === 'item_pk' ? 'n+1' : `t.${quote(c)}`);
    for (let offset = 1; offset < items; offset += 25_000) {
      const end = Math.min(items, offset + 25_000);
      const numbers = `WITH RECURSIVE seq(n) AS (SELECT ${offset} UNION ALL SELECT n+1 FROM seq WHERE n+1<${end})`;
      db.transaction(() => {
        db.exec(`${numbers} INSERT INTO items (${itemColumns.map(quote)}) SELECT ${expressions} FROM seq CROSS JOIN (SELECT * FROM items WHERE item_pk=1) t`);
        db.exec(`${numbers} INSERT INTO chunks (${chunkColumns.map(quote)}) SELECT ${chunks} FROM seq CROSS JOIN (SELECT * FROM chunks WHERE item_pk=1 LIMIT 1) t`);
        db.exec(`INSERT INTO connector_store_fts(title,bounded_text,item_pk,chunk_pk) SELECT i.title,c.bounded_text,i.item_pk,c.chunk_pk FROM items i JOIN chunks c USING(item_pk) WHERE i.item_pk>${offset} AND i.item_pk<=${end}`);
      })();
      if (performance.now() - started > 25 * 60_000) throw new Error('25 minute seed budget exhausted; existing stores retained');
    }
    db.exec('INSERT OR IGNORE INTO connector_store_fts_rows(fts_rowid,item_pk,chunk_pk) SELECT rowid,item_pk,chunk_pk FROM connector_store_fts');
    // Fixed vectors on the imported template suffice to exercise the real hybrid path.
    db.exec("INSERT INTO connector_store_fts(connector_store_fts) VALUES('optimize'); PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    manifest.push({ path, items, bytes: statSync(path).size });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    console.error(`seeded ${i+1}/${count}: ${items} items`);
  }
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
              writer.stores.internal.importItemCopy({ ...copy, identity, columns: { ...copy.columns, provider_item_id: identity.providerItemId, local_item_id: identity.localItemId } }, { trustTier: 'S3', syncConnectorId: 'synthetic-writer' });
              imports++;
              writer.ledger.recordRoutedPlacement(identity, low, writer.set.placementFor(low));
              await moveTieredItem({ set: writer.set, identity, target: high }); moves++;
            }
            await new Promise<void>(r => setTimeout(r, 10));
          }
        } catch (e) { writerError=String(e); }
      };
    }
    for (let ask=1; ask<=asks; ask++) {
      const before = rss(); const loadStart=loadavg()[0]; const beforePool=diagnostic();
      const importStart=imports; const moveStart=moves;
      let peak=before; const sampler=setInterval(() => { peak=Math.max(peak,rss()); }, 20);
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
        const run=() => routeSourceIndexSearch({ registry, adapters, request: { query, maxResults: 220, context: { allowedTrustDomains: ['internal'], allowCloudQueries: false } }, ...(args.has('budget-ms') ? { laneTimeoutMs: Number(args.get('budget-ms')) } : {}) });
        const result= traceModule?.observeSourceAnswerRoutedQuery ? await traceModule.runWithSourceAnswerTrace(trace, () => traceModule.observeSourceAnswerRetrievalAttempt('hybrid', () => traceModule.observeSourceAnswerRoutedQuery(ordinal+1, run))) : await run();
        return { ordinal: ordinal+1, wall_ms: performance.now()-start, timed_out: result.skippedCorpora.filter((s:any)=>s.reason==='lane_timeout').length, completed: result.searchedCorpora.length,
          completed_with_results: new Set(result.hits.map((h:any)=>h.corpusId)).size, hit_fingerprints: Object.fromEntries(stores.map((s:any) => [s.corpusId, Bun.hash(result.hits.filter((h:any)=>h.corpusId===s.corpusId).map((h:any)=>h.sourceItem.localItemId).sort().join('\n')).toString(16)])),
          lanes: result.corpusTimings, lane_audits: result.laneAudits, trace: trace ? traceModule.snapshotSourceAnswerTrace(trace).retrievalAttempts : undefined };
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
      const row = { label: args.get('label')??'current', source, writer: args.get('writer')??'off', ask, stores: stores.length, formulations: 3, items: selected.reduce((n,s)=>n+s.items,0),
        budget_ms: args.get('budget-ms')??'router-default', wall_ms: performance.now()-t, lanes_timed_out: results.reduce((n,r)=>n+r.timed_out,0), lanes_completed_with_results: results.reduce((n,r)=>n+r.completed_with_results,0),
        main_store_opens: stores.length, main_store_open_ms: mainOpenMs, pool_before: beforePool, pool_after: afterPool,
        rss_before_mb: before, rss_after_mb: rss(), rss_peak_mb: Math.max(peak, rss()), rss_process_high_water_mb: process.resourceUsage().maxRSS/1024, load_1m_start: loadStart, load_1m_end: loadavg()[0], imports: imports-importStart, tier_moves: moves-moveStart, writer_error: writerError, results, per_lane: perLane, lane_records: laneRecords, on_thread_keyword_reads: keywordReads };
      console.log(JSON.stringify(row));
      appendFileSync(report, `\n## ${row.label}, writer ${row.writer}, Ask ${ask}\n\n${row.lanes_completed_with_results}/${stores.length * 3} lanes with results; ${row.lanes_timed_out} timed out; ${(row.wall_ms/1000).toFixed(2)} s. RSS ${before.toFixed(1)} → ${row.rss_after_mb.toFixed(1)} MiB; peak ${peak.toFixed(1)} MiB. Imports ${row.imports}; tier moves ${row.tier_moves}.\n\n<details><summary>Full numeric receipt</summary>\n\n\`\`\`json\n${JSON.stringify(row)}\n\`\`\`\n</details>\n`);
    }
    stopped=true; await writerTask; writer?.close();
    if (writerError) throw new Error(`Writer failed: ${writerError}`);
    if (args.get('writer') === 'on' && (imports === 0 || moves === 0)) throw new Error('Writer did not import and move any items');
  }
  stores.forEach((s:any)=>s.close()); pool.shutdownReadPool?.();
} else throw new Error('Use seed, calibrate, or run');
