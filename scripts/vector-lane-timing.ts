#!/usr/bin/env bun
/**
 * Vector-lane timing on a large synthetic connector store (lane 2's ask, 14 Nov 2026; olympus-ops#151).
 *
 * The live Dropbox store held 90% of its best-ranked items for judging and had a folder scope most top-ranked items
 * fail, and its vector lane ran out its deadline on every Ask. This builds a store with that shape, then times
 * vectorSearchLane on it the way a question does, so a fix can be judged before it reaches a live machine.
 *
 *   bun scripts/vector-lane-timing.ts build   --dir <folder> [--chunks 200000] [--dimension 768]
 *   bun scripts/vector-lane-timing.ts measure --dir <folder> --scenario held|scope|both|none [--trials 5]
 *
 * build writes <folder>/store.sqlite once (one chunk per item) and is skipped when a store of the same shape is
 * there. Item i's vector leans away from the query as i grows, so low i ranks highest, and each share is periodic in
 * i, so it holds for the best-ranked items as much as for the whole store:
 *   - held for judging: every item with i % 10 != 0 (90%), through the store's own visibility seams;
 *   - out of scope: every item with i % 100 >= 10 (90%), filed under /other instead of /allowed, and asked with a
 *     locatorPathScope of /allowed;
 *   - both: the two together, so 1% of the store is servable.
 * measure prints one JSON line: per trial the lane's time, rows and skippedReason (vector_scan_deadline_exceeded is a
 * deadline cut). The caller runs measure under a memory cap below the store's size, so pages come from disk.
 * Synthetic data only: nothing here reads a real store.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { LocalConnectorStore, type ConnectorStoreSearchFilters } from '../src/workers/connector-store/local-index.ts';
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

function queryVector(dimension: number): number[] {
  const v = new Array<number>(dimension).fill(0);
  v[0] = 1;
  return v;
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
        return n === undefined ? queryVector(dimension) : itemVector(Number(n), count, dimension);
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
    async *listItems() {
      const page = 2_000;
      for (let start = 0; start < count; start += page) {
        const end = Math.min(count, start + page);
        yield { items: Array.from({ length: end - start }, (_, k) => item(start + k)), done: end === count };
      }
    },
    async fetchItem(id) { return item(Number(id.split(':')[1])); },
    classificationSignals() { return {}; },
  };
}

function open(dbPath: string): LocalConnectorStore {
  return new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.vector-timing', family: 'file', trustDomain: 'internal', tierLedger: null });
}

async function build(dir: string, count: number, dimension: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'store.sqlite');
  const shapePath = join(dir, 'shape.json');
  const shape = JSON.stringify({ count, dimension, version: 1 });
  if (existsSync(dbPath) && existsSync(shapePath) && readFileSync(shapePath, 'utf8') === shape) {
    console.log(JSON.stringify({ phase: 'build', reused: true, bytes: statSync(dbPath).size }));
    return;
  }
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

async function measure(dir: string, scenario: string, trials: number): Promise<void> {
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
    const results: Array<{ ms: number; rows: number; skippedReason?: string; servable: boolean }> = [];
    for (let t = 0; t < trials; t++) {
      // A different question each trial (same direction, different words), so no memo answers it.
      const started = performance.now();
      const result = await store.vectorSearchLane(`coverage question ${t} ${Date.now()}`, embedder, 20, undefined, filters, Date.now() + LANE_DEADLINE_MS);
      const ms = Math.round(performance.now() - started);
      // Every row must be one the store may serve: in scope, and not held.
      const servable = result.rows.every((row) => {
        const i = Number(row.sourceItem.providerItemId);
        return (!filters || inScope(i)) && (scenario === 'held' || scenario === 'both' ? !held(i) : true);
      });
      results.push({ ms, rows: result.rows.length, ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}), servable });
    }
    const pass = results.every((r) => r.ms < PASS_MS && !r.skippedReason && r.rows > 0 && r.servable);
    console.log(JSON.stringify({ phase: 'measure', scenario, chunks: shape.count, dimension: shape.dimension, bytes: statSync(join(dir, 'store.sqlite')).size, digest: process.env.OLYMPUS_VECTOR_DIGEST ?? 'default', pass, trials: results }));
  } finally { store.close(); }
}

const [command, ...rest] = process.argv.slice(2);
const values = args(rest);
const dir = values.get('dir');
if (!dir || (command !== 'build' && command !== 'measure')) {
  console.error('Usage: bun scripts/vector-lane-timing.ts build|measure --dir <folder> [--chunks N] [--dimension D] [--scenario held|scope|both|none] [--trials N]');
  process.exit(2);
}
if (command === 'build') await build(dir, Number(values.get('chunks') ?? 200_000), Number(values.get('dimension') ?? 768));
else await measure(dir, values.get('scenario') ?? 'both', Number(values.get('trials') ?? 5));
process.exit(0);
