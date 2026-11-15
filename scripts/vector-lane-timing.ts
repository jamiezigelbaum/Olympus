#!/usr/bin/env bun
/**
 * Vector-lane timing on a large synthetic connector store (lane 2's ask, 14 Nov 2026; olympus-ops#151).
 *
 * The live Dropbox store held 90% of its best-ranked items for judging and had a folder scope most top-ranked items
 * fail, and its vector lane ran out its deadline on every Ask. This builds a store with that shape, then times
 * vectorSearchLane on it the way a question does, so a fix can be judged before it reaches a live machine.
 *
 *   bun scripts/vector-lane-timing.ts build   --dir <folder> [--chunks 200000] [--dimension 768]
 *   bun scripts/vector-lane-timing.ts measure --dir <folder> --scenario held|scope|both|none [--trials 5] [--contend keyword,writer]
 *
 * build writes <folder>/store.sqlite once (one chunk per item) and is skipped when a store of the same shape is
 * there (version 2 since 15 Nov: shuffled layout). Item i's vector leans away from the shared direction as i grows, so low
 * i ranks highest; each question lies near one of the best-ranked 2,000 plus noise. Items are written in a seeded shuffle,
 * and each trial starts with the store out of the page cache. Each share is periodic in i, so it holds for the
 * best-ranked items as much as for the whole store:
 *   - held for judging: every item with i % 10 != 0 (90%), through the store's own visibility seams;
 *   - out of scope: every item with i % 100 >= 10 (90%), filed under /other instead of /allowed, and asked with a
 *     locatorPathScope of /allowed;
 *   - both: the two together, so 1% of the store is servable.
 * measure prints one JSON line: per trial the lane's time, rows and skippedReason (vector_scan_deadline_exceeded is a
 * deadline cut). The caller runs measure under a memory cap below the store's size, so pages come from disk.
 * --contend adds load while the lane runs (lane 2's suspect, 15 Nov: the live keyword lane took 18.8 s on the same store,
 * and the store has one read-pool thread whose wait counts against the vector deadline):
 *   - keyword: keyword searches on the same store, back to back, sharing its read pool;
 *   - writer: another process committing a judged-items-sized write (50 items and their chunks) every 300 ms, as the
 *     background's judge does beside a question.
 * Synthetic data only: nothing here reads a real store.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { openConnectorStore, storageAccountForCorpus } from '../src/core/source-storage.ts';
import type { LocalConnectorStore, ConnectorStoreSearchFilters } from '../src/workers/connector-store/local-index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const MODEL_ID = 'vector-lane-timing';
/** The live lane's deadline (the Ask's 54 s), so a slow pass shows as time, not as an early cut. */
const LANE_DEADLINE_MS = 54_000;
const PASS_MS = 3_000;
const WORDS = 'harbor ledger quarterly invoice policy coverage renewal clause schedule deductible premium claim travel notes meeting draft budget review letter contract summary report plan'.split(' ');

function args(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) if (argv[i]!.startsWith('--')) values.set(argv[i]!.slice(2), argv[i + 1] ?? '');
  return values;
}

/** A seeded generator, so every build of the same shape writes the same vectors. */
function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * A question's vector, shaped like a real one: near a stored item's vector (one of the best-ranked 2,000, picked by the
 * seed) plus noise, rather than a basis vector every item leans toward.
 */
function queryVector(seed: number, count: number, dimension: number): number[] {
  // Spread the seed first: xorshift's first draws from neighbouring seeds are close.
  const next = random(Math.imul(seed + 1, 2654435761) >>> 0);
  next();
  const near = itemVector(Math.floor(next() * Math.min(count, 2_000)), count, dimension);
  // Noise of about 0.2 in all, whatever the dimension.
  const scale = 0.7 / Math.sqrt(dimension);
  const v = near.map((x) => x + (next() - 0.5) * scale);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** Item i's vector: the query's direction, weaker as i grows, plus seeded noise. */
function itemVector(i: number, count: number, dimension: number): number[] {
  const next = random(i + 7919);
  const lean = i / count;
  const v = Array.from({ length: dimension }, () => (next() - 0.5) * 2);
  let norm = Math.hypot(...v.slice(1));
  for (let d = 1; d < dimension; d++) v[d] = (v[d]! / norm) * (0.35 + 0.6 * lean);
  v[0] = 1 - 0.6 * lean;
  norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

function provider(count: number, dimension: number): SourceEmbeddingProvider {
  return {
    provider: 'built-in', backend: 'local', modelId: MODEL_ID, dimension, configHash: `timing-${dimension}`, epochId: '1',
    async embed(inputs) {
      return inputs.map((input) => {
        const n = /#(\d+)\s*$/.exec(input.text)?.[1];
        const seed = Number(/seed (\d+)/.exec(input.text)?.[1] ?? 0);
        return n === undefined ? queryVector(seed, count, dimension) : itemVector(Number(n), count, dimension);
      });
    },
  };
}

const inScope = (i: number) => i % 100 < 10;
const held = (i: number) => i % 10 !== 0;

function connector(count: number): SourceConnector {
  const item = (i: number): RawItem => {
    const next = random(i + 104729);
    const words = Array.from({ length: 140 }, () => WORDS[Math.floor(next() * WORDS.length)]).join(' ');
    return {
      identity: { family: 'file', provider: 'fixture', accountScope: 'a', providerItemId: String(i), localItemId: `a:${i}`, sourceVersion: '1' },
      mimeType: 'text/plain', content: { kind: 'text', text: `${words} #${i}` },
      metadata: { name: `note${i}.txt`, locatorUri: `${inScope(i) ? '/allowed' : '/other'}/${Math.floor(i / 1000)}/note${i}.txt`, authoredAt: '2026-11-01T00:00:00Z' },
      fetchedAt: '2026-11-01T00:00:00Z',
    };
  };
  return {
    id: 'fixture', family: 'file', async authenticate() {},
    // Items arrive in a seeded shuffle, so chunk_pk order is unrelated to rank and a re-score reads scattered pages,
    // as on a live store filled over years.
    async *listItems() {
      const order = Array.from({ length: count }, (_, k) => k);
      const next = random(99991);
      for (let k = count - 1; k > 0; k--) { const j = Math.floor(next() * (k + 1)); [order[k], order[j]] = [order[j]!, order[k]!]; }
      const page = 2_000;
      for (let start = 0; start < count; start += page) {
        const end = Math.min(count, start + page);
        yield { items: order.slice(start, end).map(item), done: end === count };
      }
    },
    async fetchItem(id) { return item(Number(id.split(':')[1])); },
    classificationSignals() { return {}; },
  };
}

/** Through the storage service, with a home of its own beside the store, so its registry is this folder's alone. */
function open(dbPath: string): LocalConnectorStore {
  const options = { dbPath, corpusId: 'internal.fixture.vector-timing', family: 'file' as const, trustDomain: 'internal' as const, tierLedger: null };
  const home = join(dbPath, '..', 'home');
  return openConnectorStore(storageAccountForCorpus(options), options, { ...process.env, HOME: home, XDG_DATA_HOME: join(home, 'data') });
}

async function build(dir: string, count: number, dimension: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'store.sqlite');
  const shapePath = join(dir, 'shape.json');
  const shape = JSON.stringify({ count, dimension, version: 2 });
  if (existsSync(dbPath) && existsSync(shapePath) && readFileSync(shapePath, 'utf8') === shape) {
    console.log(JSON.stringify({ phase: 'build', reused: true, bytes: statSync(dbPath).size }));
    return;
  }
  // Another shape (version 1 wrote items in rank order): start over, so no row of it survives.
  for (const name of readdirSync(dir)) if (name.startsWith('store.sqlite') || name === 'shape.json' || name === 'home') rmSync(join(dir, name), { recursive: true, force: true });
  const started = Date.now();
  const store = open(dbPath);
  try {
    (store as unknown as { db: { exec(sql: string): void } }).db.exec('PRAGMA synchronous=OFF');
    await store.syncFromConnector(connector(count), { fetchContent: true });
    const synced = Date.now();
    const embedder = provider(count, dimension);
    for (;;) {
      const summary = await store.embedChunks({ provider: embedder, limit: 20_000 });
      if (summary.chunksEmbedded === 0) break;
    }
    const embedded = Date.now();
    while (!(await store.ensureVectorDigestReady(MODEL_ID, 64)).completed) { /* windows until done */ }
    writeFileSync(shapePath, shape);
    console.log(JSON.stringify({ phase: 'build', reused: false, bytes: statSync(dbPath).size, syncMs: synced - started, embedMs: embedded - synced, digestMs: Date.now() - embedded }));
  } finally { store.close(); }
}

/** The writer process: a judged batch's worth of rows rewritten every interval until it is stopped. */
async function write(dir: string, intervalMs: number): Promise<void> {
  const shape = JSON.parse(readFileSync(join(dir, 'shape.json'), 'utf8')) as { count: number };
  const store = open(join(dir, 'store.sqlite'));
  const db = (store as unknown as { db: { exec(sql: string): void; query(sql: string): { run(...params: unknown[]): unknown } } }).db;
  const items = db.query('UPDATE items SET indexed_at = ? WHERE item_pk BETWEEN ? AND ?');
  const chunks = db.query('UPDATE chunks SET indexed_at = ? WHERE item_pk BETWEEN ? AND ?');
  let commits = 0;
  let stop = false;
  process.on('SIGTERM', () => { stop = true; });
  const next = random(4242);
  while (!stop) {
    const from = 1 + Math.floor(next() * Math.max(1, shape.count - 50));
    const at = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    items.run(at, from, from + 49);
    chunks.run(at, from, from + 49);
    db.exec('COMMIT');
    commits += 1;
    await Bun.sleep(intervalMs);
  }
  store.close();
  console.log(JSON.stringify({ phase: 'write', commits }));
}

async function measure(dir: string, scenario: string, trials: number, contend: ReadonlySet<string>): Promise<void> {
  const shape = JSON.parse(readFileSync(join(dir, 'shape.json'), 'utf8')) as { count: number; dimension: number };
  const store = open(join(dir, 'store.sqlite'));
  try {
    const pks = new Map<number, number>();
    for (const row of (store as unknown as { db: { query(sql: string): { all(): Array<{ item_pk: number; provider_item_id: string }> } } }).db
      .query('SELECT item_pk, provider_item_id FROM items').all()) pks.set(row.item_pk, Number(row.provider_item_id));
    if (pks.size !== shape.count) throw new Error(`the store holds ${pks.size} items, not ${shape.count}`);
    if (scenario === 'held' || scenario === 'both') {
      // The store's own seams, as the unit test sets them: the tier hide set and the live visibility check agree.
      const heldPks = [...pks].filter(([, i]) => held(i)).map(([pk]) => pk);
      const heldSet = new Set(heldPks);
      const value = { hidden: [], held: heldPks, heldForJudgment: heldPks, metadataLayer: [], metadataLayerContentUnread: [], moving: 0 };
      const lane = store as unknown as { tierHiddenItemPks(): typeof value; visibleVectorItemPks(candidates: readonly number[]): Set<number> };
      lane.tierHiddenItemPks = () => value;
      lane.visibleVectorItemPks = (candidates) => new Set(candidates.filter((pk) => !heldSet.has(pk)));
    }
    const filters: ConnectorStoreSearchFilters | undefined = scenario === 'scope' || scenario === 'both' ? { locatorPathScope: '/allowed' } : undefined;
    const embedder = provider(shape.count, shape.dimension);
    const results: Array<{ ms: number; rows: number; skippedReason?: string; servable: boolean; ids: string }> = [];
    // The process's resident memory, sampled through the run: the read pool's workers are threads of this process.
    let rssPeak = process.memoryUsage().rss;
    const rssTimer = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 100);
    const writer = contend.has('writer')
      ? Bun.spawn(['bun', import.meta.path, 'write', '--dir', dir, '--interval', '300'], { stdout: 'pipe', stderr: 'inherit' })
      : undefined;
    if (writer) await Bun.sleep(1_000);
    const keyword: number[] = [];
    let keywordBusy = 0;
    let measuring = true;
    const keywordLoop = contend.has('keyword') ? (async () => {
      for (let k = 0; measuring; k++) {
        const started = performance.now();
        try { await store.searchItemsDetailedOffThread(`${WORDS[k % WORDS.length]} ${WORDS[(k * 7 + 3) % WORDS.length]} coverage`, 20, undefined, filters, {}, { deadlineAtMs: Date.now() + LANE_DEADLINE_MS }); }
        catch { keywordBusy += 1; }
        keyword.push(Math.round(performance.now() - started));
      }
    })() : undefined;
    if (keywordLoop) await Bun.sleep(500);
    for (let t = 0; t < trials; t++) {
      // Every trial starts cold: the store's pages leave the page cache (posix_fadvise DONTNEED through dd, no root).
      for (const suffix of ['', '-wal', '-shm']) spawnSync('dd', [`if=${join(dir, `store.sqlite${suffix}`)}`, 'iflag=nocache', 'count=0', 'status=none']);
      // A different question each trial, near a different stored item, so no memo answers it.
      const started = performance.now();
      const result = await store.vectorSearchLane(`coverage question seed ${t + 1} ${Date.now()}`, embedder, 20, undefined, filters, Date.now() + LANE_DEADLINE_MS);
      const ms = Math.round(performance.now() - started);
      // Every row must be one the store may serve: in scope, and not held.
      const servable = result.rows.every((row) => {
        const i = Number(row.sourceItem.providerItemId);
        return (!filters || inScope(i)) && (scenario === 'held' || scenario === 'both' ? !held(i) : true);
      });
      // Which items, in rank order, so two heads can be compared row for row.
      const ids = result.rows.map((row) => row.sourceItem.providerItemId).join(' ');
      results.push({ ms, rows: result.rows.length, ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}), servable, ids });
    }
    measuring = false;
    clearInterval(rssTimer);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    await keywordLoop;
    let commits: number | undefined;
    if (writer) {
      writer.kill('SIGTERM');
      const out = await new Response(writer.stdout).text();
      await writer.exited;
      commits = (JSON.parse(out.trim().split('\n').at(-1) || '{}') as { commits?: number }).commits;
    }
    const sorted = [...keyword].sort((a, b) => a - b);
    const load = {
      ...(keywordLoop ? { keyword: { calls: keyword.length, busy: keywordBusy, p50Ms: sorted[Math.floor(sorted.length / 2)] ?? null, maxMs: sorted.at(-1) ?? null } } : {}),
      ...(writer ? { writer: { commits: commits ?? null, intervalMs: 300 } } : {}),
    };
    const pass = results.every((r) => r.ms < PASS_MS && !r.skippedReason && r.rows > 0 && r.servable);
    console.log(JSON.stringify({ phase: 'measure', scenario, contend: [...contend].join(',') || 'none', ...load, rssPeakMb: Math.round(rssPeak / 1024 / 1024), chunks: shape.count, dimension: shape.dimension, bytes: statSync(join(dir, 'store.sqlite')).size, digest: process.env.OLYMPUS_VECTOR_DIGEST ?? 'default', pass, trials: results }));
  } finally { store.close(); }
}

const [command, ...rest] = process.argv.slice(2);
const values = args(rest);
const dir = values.get('dir');
if (!dir || (command !== 'build' && command !== 'measure' && command !== 'write')) {
  console.error('Usage: bun scripts/vector-lane-timing.ts build|measure --dir <folder> [--chunks N] [--dimension D] [--scenario held|scope|both|none] [--trials N] [--contend keyword,writer]');
  process.exit(2);
}
if (command === 'build') await build(dir, Number(values.get('chunks') ?? 200_000), Number(values.get('dimension') ?? 768));
else if (command === 'write') await write(dir, Number(values.get('interval') ?? 300));
else await measure(dir, values.get('scenario') ?? 'both', Number(values.get('trials') ?? 5), new Set((values.get('contend') ?? '').split(',').filter(Boolean)));
process.exit(0);
