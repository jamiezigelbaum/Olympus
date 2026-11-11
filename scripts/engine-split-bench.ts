// Synthetic, disposable measurement for the engine split design (#1064).
// Never opens live stores: it builds its own tiered store set in a temp
// directory and measures what a dashboard or Ask request waits for while an
// import writes to the same stores, in three layouts:
//
//   same     the writer and the requests share one JavaScript thread (today)
//   thread   the writer runs in a Bun Worker; requests read on the main thread
//   process  the writer runs in a child process; requests read in this one
//
// A "request" is what the search adapter does per store on every Ask query:
// the vector-lane check (vectorLaneServable, which asks hasEmbeddings; before
// part 1 that rebuilt the hidden-copy set) and the keyword search. A heartbeat every 50 ms measures how long the
// requesting thread went without turning (a freeze).
//
// --reads here runs the keyword search on the requesting thread (before part
// 2); --reads pool runs it on the read pool (searchItemsDetailedOffThread,
// part 2, as the Ask lanes do on main). So `same --reads pool` is one process
// with parts 1 and 2, and `process --reads pool` is the split.
//
// Requests arrive on a fixed schedule (--every-ms, default 250), whether or
// not the previous one has finished, so every layout is offered the same
// load; a request's time runs from its scheduled arrival. Every layout
// measures the same window (2 s after the writer starts, for --seconds - 4).
// A request the pool refuses as busy, or one shed because 8 earlier requests
// were still unfinished when it arrived, is counted, not timed.
//
// The seed has children (every --child-every'th item is an attachment of the
// item before it) and a current vector on every chunk, so the child rule and
// the vector-lane check have work to do.
//
//   bun scripts/engine-split-bench.ts seed  [--items 500000] [--child-every 5] [--dir PATH]
//   bun scripts/engine-split-bench.ts run   --mode same|thread|process [--reads here|pool] [--requests ask|status] [--every-ms 250] [--dir PATH] [--seconds 60]
//
// --requests status (#858) makes each request what a dashboard status poll
// asks of every store whose counts have expired, instead of an Ask: the
// status handler's prepareStatusCounts, then the counts with the snapshot
// allowance (STORE_STATUS_REUSE_MS) read off the thread. Its times are in
// keyword_ms; vector_lane_check_ms stays 0.
//
// Output is one JSON line per run. The seed is kept in --dir and copied per run.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { OffThreadReadBusyError } from '../src/workers/connector-store/off-thread-reads.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localProvider, openTierFixture, storePaths } from '../test/helpers/tier-fixtures.ts';

const args = new Map<string, string>();
for (let n = 3; n < process.argv.length; n += 2) args.set(process.argv[n]!.replace(/^--/, ''), process.argv[n + 1] ?? '');
const command = process.argv[2];
const childEvery = Number(args.get('child-every') ?? 5);
const seedDir = args.get('dir') ?? join(tmpdir(), 'olympus-engine-split-seed');
const WORDS = ('orchard apple pear invoice lawyer school budget dinner flight hotel meeting report draft notary garden '
  + 'piano harbour lisbon porto train tax parenting plan dentist rental lease contract salary holiday birthday '
  + 'recipe bicycle repair plumber insurance mortgage passport visa doctor pharmacy football concert museum').split(' ');
const word = (n: number) => WORDS[((n % WORDS.length) + WORDS.length) % WORDS.length]!;
const textFor = (n: number) => `${word(n)} ${word(n * 7)} ${word(n * 13)} note ${n} about the ${word(n * 3)} and the ${word(n * 11)}, `
  + `sent after the ${word(n * 17)} with a question about ${word(n * 19)}.`;

const rss = (pid = process.pid) => {
  try {
    const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((l) => l.startsWith('VmRSS:'));
    return line ? Math.round(Number(line.replace(/\D+/g, '')) / 1024) : undefined;
  } catch { return pid === process.pid ? Math.round(process.memoryUsage().rss / 1048576) : undefined; }
};

/** Opens the fixture set and returns the template copy the writer clones. */
async function openWriter(dir: string) {
  const f = openTierFixture(dir, { embed: true, paths: storePaths(dir), secretsPath: join(dir, 'secret-locations.sqlite') });
  const text = textFor(0);
  const lower = classifyItemTiers({ signals: { title: 'Synthetic' }, text });
  const high = { ...lower, metadataTier: 'secure' as const, contentTier: 'secure' as const };
  if (!f.stores.secure_local!.exportItemCopy(identityOf('template'))) {
    await f.set.sync(fixtureConnector(() => [{ id: 'template', name: 'Synthetic', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    await moveTieredItem({ set: f.set, identity: identityOf('template'), target: high });
  }
  // The template's chunks get a current vector from the Private store's fake
  // local embedder; every imported copy carries it.
  await f.stores.secure_local!.embedChunks({ provider: f.local });
  const copy = f.stores.secure_local!.exportItemCopy(identityOf('template'))!;
  const sdb = (f.stores.secure_local as any).db;
  const ldb = (f.ledger as any).db;
  if (!copy.vectors.some((vector) => vector.modelId === f.local.modelId)) throw new Error('the template copy has no current vector');
  /**
   * One import batch: `size` new items, every `movingEvery`th one also routed
   * lower (a pending move), every `childEvery`th one an attachment of the item
   * before it. Every chunk carries the template's current vector.
   */
  const importBatch = (from: number, size: number, movingEvery: number) => {
    ldb.transaction(() => sdb.transaction(() => {
      for (let n = from; n < from + size; n++) {
        const identity = identityOf(`synthetic-${n}`, `chat-${n % 400}`);
        const parent = childEvery > 0 && n % childEvery === 1 ? identityOf(`synthetic-${n - 1}`, `chat-${(n - 1) % 400}`) : undefined;
        const body = textFor(n);
        f.stores.secure_local!.importItemCopy({
          ...copy, identity,
          columns: { ...copy.columns, provider_item_id: identity.providerItemId, local_item_id: identity.localItemId,
            provider_conversation_id: identity.providerConversationId ?? null, title: `Note ${n}`, search_text: body,
            parent_local_item_id: parent?.localItemId ?? null },
          chunks: copy.chunks.map((chunk) => ({ ...chunk, boundedText: body })),
        }, { trustTier: 'S4', syncConnectorId: 'engine-split-bench', vectorProvider: f.local });
        f.ledger.recordRoutedPlacement(identity, high, f.set.placementFor(high));
        if (n % movingEvery === 0) f.ledger.recordRoutedPlacement(identity, lower, f.set.placementFor(lower));
      }
    })())();
  };
  return { f, importBatch, modelId: f.local.modelId };
}

async function seed(): Promise<void> {
  const items = Number(args.get('items') ?? 500_000);
  rmSync(seedDir, { recursive: true, force: true });
  mkdirSync(seedDir, { recursive: true });
  const started = performance.now();
  const { f, importBatch } = await openWriter(seedDir);
  // About half the backlog is pending a move, as on Sparta (2026-11-04: 645k
  // items waiting for the sniffer): those identities are walked by every
  // full hidden-set rebuild.
  for (let n = 0; n < items; n += 500) importBatch(n, Math.min(500, items - n), 2);
  f.close();
  console.log(JSON.stringify({ seeded: items, child_every: childEvery, dir: seedDir, ms: Math.round(performance.now() - started) }));
}

/** The writer loop: imports at full speed with a macrotask between batches, as ingestion turns do. */
async function writerLoop(dir: string, seconds: number, report: (line: Record<string, unknown>) => void): Promise<void> {
  const { f, importBatch } = await openWriter(dir);
  const base = 10_000_000;
  let written = 0;
  const started = performance.now();
  let maxBatchMs = 0;
  while (performance.now() - started < seconds * 1000) {
    const t = performance.now();
    importBatch(base + written, 25, 4);
    maxBatchMs = Math.max(maxBatchMs, performance.now() - t);
    written += 25;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  f.close();
  report({ written, items_per_min: Math.round(written / ((performance.now() - started) / 60_000)), max_batch_ms: Math.round(maxBatchMs), writer_rss_mb: rss() });
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1) ?? 0) };
}

/** The dashboard's counts allowance (source-index/status.ts STORE_STATUS_REUSE_MS). */
const STATUS_COUNTS_ALLOWANCE_MS = 5 * 60_000;

/** Requests waiting at once, as the read pool's per-store queue (READ_POOL_QUEUE_PER_STORE). */
const MAX_IN_FLIGHT = 8;

/**
 * Requests and heartbeat on this thread, against `stores`, for `seconds`.
 * Requests arrive every `everyMs` on a fixed schedule (an open loop), so a
 * slow layout queues requests instead of being offered fewer.
 */
async function front(stores: LocalConnectorStore[], seconds: number, reads: 'here' | 'pool', modelId: string, everyMs: number, requests: 'ask' | 'status' = 'ask') {
  const latencies: number[] = [];
  const visibility: number[] = [];
  const keyword: number[] = [];
  const freezes: number[] = [];
  let busy = 0;
  let expected = performance.now() + 50;
  const beat = setInterval(() => {
    const now = performance.now();
    freezes.push(Math.max(0, now - expected));
    expected = now + 50;
  }, 50);
  const request = async (q: number, arrival: number) => {
    let v = 0;
    let k = 0;
    try {
      for (const store of stores) {
        const t0 = performance.now();
        if (requests === 'status') {
          await store.prepareStatusCounts(undefined);
          await store.statusOffThread(undefined, { countsMaxAgeMs: STATUS_COUNTS_ALLOWANCE_MS });
          k += performance.now() - t0;
          continue;
        }
        store.vectorLaneServable(modelId);
        const t1 = performance.now();
        const text = `${word(q)} ${word(q * 5)}`;
        if (reads === 'pool') await store.searchItemsDetailedOffThread(text, 20);
        else store.searchItemsDetailed(text, 20);
        v += t1 - t0;
        k += performance.now() - t1;
      }
    } catch (error) {
      if (error instanceof OffThreadReadBusyError) { busy++; return; }
      throw error;
    }
    visibility.push(v);
    keyword.push(k);
    latencies.push(performance.now() - arrival);
  };
  const started = performance.now();
  const ends = started + seconds * 1000;
  // Every admitted request, from its arrival until it finishes. A request
  // is in the system at a moment when it arrived before it and had not
  // finished by it, whether it was still waiting for the thread (an arrival
  // that passed while the thread was blocked) or running.
  const admitted: Array<{ end?: number; done: Promise<void> }> = [];
  let offered = 0;
  let shed = 0;
  for (let q = 0; started + q * everyMs < ends; q++) {
    const arrival = started + q * everyMs;
    // A request arrives and waits for the thread, even when it is already late.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, arrival - performance.now())));
    offered++;
    // Admission is decided as of the request's arrival, the same in every
    // mode: with MAX_IN_FLIGHT already in the system then, it is shed and
    // counted, so the run stays bounded in time.
    const waiting = admitted.filter((entry) => entry.end === undefined || entry.end > arrival).length;
    if (waiting >= MAX_IN_FLIGHT) { shed++; continue; }
    const entry: { end?: number; done: Promise<void> } = { done: Promise.resolve() };
    admitted.push(entry);
    entry.done = request(q, arrival).finally(() => { entry.end = performance.now(); });
  }
  await Promise.all(admitted.map((entry) => entry.done));
  clearInterval(beat);
  return { offered, shed, busy, request_ms: stats(latencies), vector_lane_check_ms: stats(visibility), keyword_ms: stats(keyword),
    freeze_ms: stats(freezes), front_rss_mb: rss() };
}

/**
 * Readers for the run's copy. Each gets the run's own ledger explicitly: the
 * copied stores' bindings still record the seed ledger's path, which exists
 * with the same id, so a lookup by binding would read the unchanged seed.
 */
function readStores(dir: string, readOnly: boolean): { stores: LocalConnectorStore[]; ledger: TierLedger } {
  const paths = storePaths(dir);
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local), readOnly });
  const stores = (['internal', 'secure_local'] as const).filter((d) => existsSync(paths[d])).map((d) => new LocalConnectorStore({
    dbPath: paths[d], corpusId: CORPORA[d], family: 'file', trustDomain: d, readOnly, tierLedger: ledger,
  }));
  return { stores, ledger };
}

async function run(): Promise<void> {
  const mode = args.get('mode') ?? 'same';
  const reads = args.get('reads') === 'pool' ? 'pool' : 'here';
  const requests = args.get('requests') === 'status' ? 'status' : 'ask';
  const everyMs = Number(args.get('every-ms') ?? 250);
  const seconds = Number(args.get('seconds') ?? 60);
  const modelId = localProvider().modelId;
  const dir = join(tmpdir(), `olympus-engine-split-run-${mode}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(seedDir, dir, { recursive: true });
  try {
    let writer: Promise<Record<string, unknown>>;
    let childPid: number | undefined;
    let close: () => void;
    let stores: LocalConnectorStore[];
    if (mode === 'same') {
      const { f, importBatch } = await openWriter(dir);
      stores = [f.stores.internal!, f.stores.secure_local!];
      close = () => f.close();
      writer = (async () => {
        let written = 0;
        const started = performance.now();
        let maxBatchMs = 0;
        while (performance.now() - started < seconds * 1000) {
          const t = performance.now();
          importBatch(10_000_000 + written, 25, 4);
          maxBatchMs = Math.max(maxBatchMs, performance.now() - t);
          written += 25;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return { written, items_per_min: Math.round(written / ((performance.now() - started) / 60_000)), max_batch_ms: Math.round(maxBatchMs) };
      })();
    } else {
      if (mode === 'thread') {
        const worker = new Worker(new URL(import.meta.url).href, { argv: ['writer', '--dir', dir, '--seconds', String(seconds)] } as any);
        writer = new Promise((resolve) => { worker.onmessage = (event) => resolve(event.data); });
      } else {
        const child = Bun.spawn([process.execPath, import.meta.path, 'writer', '--dir', dir, '--seconds', String(seconds)], { stdout: 'pipe', stderr: 'inherit' });
        childPid = child.pid;
        writer = new Response(child.stdout).text().then((text) => JSON.parse(text.trim().split('\n').at(-1)!));
      }
      stores = [];
      close = () => {};
    }
    // Every layout measures the same window: from 2 s after the writer
    // starts (a separate writer opens its stores first) to 2 s before it ends.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (mode !== 'same') {
      const readers = readStores(dir, true);
      stores = readers.stores;
      close = () => { for (const store of stores) store.close(); readers.ledger.close(); };
    }
    let childRssPeak = 0;
    let rssPeak = 0;
    const sampler = setInterval(() => {
      rssPeak = Math.max(rssPeak, rss() ?? 0);
      if (childPid) childRssPeak = Math.max(childRssPeak, rss(childPid) ?? 0);
    }, 1000);
    const measured = await front(stores, seconds - 4, reads, modelId, everyMs, requests);
    clearInterval(sampler);
    const result = await writer;
    close();
    console.log(JSON.stringify({ mode, reads, requests, every_ms: everyMs, seconds, ...measured,
      writer: { ...result, ...(childPid ? { writer_rss_peak_mb: childRssPeak } : {}) }, process_rss_mb: rss(), process_rss_peak_mb: rssPeak }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (command === 'seed') await seed();
else if (command === 'run') await run();
else if (command === 'writer' || (typeof Bun !== 'undefined' && !Bun.isMainThread)) {
  const workerArgs = Bun.isMainThread ? args : new Map(Object.entries({ dir: process.argv.at(-3) ?? '', seconds: process.argv.at(-1) ?? '60' }));
  await writerLoop(workerArgs.get('dir')!, Number(workerArgs.get('seconds')), (line) => {
    if (Bun.isMainThread) console.log(JSON.stringify(line)); else postMessage(line);
  });
} else {
  console.error('usage: engine-split-bench.ts seed|run [--items N] [--child-every N] [--mode same|thread|process] [--reads here|pool] [--every-ms MS] [--seconds S] [--dir PATH]');
  process.exit(2);
}
