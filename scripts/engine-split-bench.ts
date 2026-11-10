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
// hasEmbeddings (which decides the vector lane and rebuilds the hidden-copy
// set) and the synchronous keyword search. A heartbeat every 50 ms measures
// how long the requesting thread went without turning (a freeze).
//
//   bun scripts/engine-split-bench.ts seed  [--items 500000] [--dir PATH]
//   bun scripts/engine-split-bench.ts run   --mode same|thread|process [--dir PATH] [--seconds 60]
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
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, storePaths } from '../test/helpers/tier-fixtures.ts';

const args = new Map<string, string>();
for (let n = 3; n < process.argv.length; n += 2) args.set(process.argv[n]!.replace(/^--/, ''), process.argv[n + 1] ?? '');
const command = process.argv[2];
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
  const f = openTierFixture(dir, { embed: false, paths: storePaths(dir), secretsPath: join(dir, 'secret-locations.sqlite') });
  const text = textFor(0);
  const lower = classifyItemTiers({ signals: { title: 'Synthetic' }, text });
  const high = { ...lower, metadataTier: 'secure' as const, contentTier: 'secure' as const };
  if (!f.stores.secure_local!.exportItemCopy(identityOf('template'))) {
    await f.set.sync(fixtureConnector(() => [{ id: 'template', name: 'Synthetic', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    await moveTieredItem({ set: f.set, identity: identityOf('template'), target: high });
  }
  const copy = f.stores.secure_local!.exportItemCopy(identityOf('template'))!;
  const sdb = (f.stores.secure_local as any).db;
  const ldb = (f.ledger as any).db;
  /** One import batch: `size` new items, every `movingEvery`th one also routed lower (a pending move). */
  const importBatch = (from: number, size: number, movingEvery: number) => {
    ldb.transaction(() => sdb.transaction(() => {
      for (let n = from; n < from + size; n++) {
        const identity = identityOf(`synthetic-${n}`, `chat-${n % 400}`);
        const body = textFor(n);
        f.stores.secure_local!.importItemCopy({
          ...copy, identity,
          columns: { ...copy.columns, provider_item_id: identity.providerItemId, local_item_id: identity.localItemId,
            provider_conversation_id: identity.providerConversationId ?? null, title: `Note ${n}`, search_text: body },
          chunks: copy.chunks.map((chunk) => ({ ...chunk, boundedText: body })),
        }, { trustTier: 'S4', syncConnectorId: 'engine-split-bench' });
        f.ledger.recordRoutedPlacement(identity, high, f.set.placementFor(high));
        if (n % movingEvery === 0) f.ledger.recordRoutedPlacement(identity, lower, f.set.placementFor(lower));
      }
    })())();
  };
  return { f, importBatch };
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
  console.log(JSON.stringify({ seeded: items, dir: seedDir, ms: Math.round(performance.now() - started) }));
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

/** Requests and heartbeat on this thread, against `stores`, for `seconds`. */
async function front(stores: LocalConnectorStore[], seconds: number) {
  const latencies: number[] = [];
  const visibility: number[] = [];
  const keyword: number[] = [];
  const freezes: number[] = [];
  let expected = performance.now() + 50;
  const beat = setInterval(() => {
    const now = performance.now();
    freezes.push(Math.max(0, now - expected));
    expected = now + 50;
  }, 50);
  const started = performance.now();
  let q = 0;
  while (performance.now() - started < seconds * 1000) {
    const asked = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 0)); // a request arrives and waits for the thread
    let v = 0;
    let k = 0;
    for (const store of stores) {
      const t0 = performance.now();
      store.hasEmbeddings('engine-split-bench-model');
      const t1 = performance.now();
      store.searchItemsDetailed(`${word(q)} ${word(q * 5)}`, 20);
      v += t1 - t0;
      k += performance.now() - t1;
    }
    visibility.push(v);
    keyword.push(k);
    latencies.push(performance.now() - asked);
    q++;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  clearInterval(beat);
  return { request_ms: stats(latencies), has_embeddings_ms: stats(visibility), keyword_ms: stats(keyword), freeze_ms: stats(freezes), front_rss_mb: rss() };
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
  const seconds = Number(args.get('seconds') ?? 60);
  const dir = join(tmpdir(), `olympus-engine-split-run-${mode}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(seedDir, dir, { recursive: true });
  try {
    let writer: Promise<Record<string, unknown>>;
    let stores: LocalConnectorStore[];
    let childPid: number | undefined;
    if (mode === 'same') {
      const { f, importBatch } = await openWriter(dir);
      stores = [f.stores.internal!, f.stores.secure_local!];
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
      const measured = await front(stores, seconds);
      const result = await writer;
      f.close();
      console.log(JSON.stringify({ mode, seconds, ...measured, writer: result }));
      return;
    }
    if (mode === 'thread') {
      const worker = new Worker(new URL(import.meta.url).href, { argv: ['writer', '--dir', dir, '--seconds', String(seconds)] } as any);
      writer = new Promise((resolve) => { worker.onmessage = (event) => resolve(event.data); });
    } else {
      const child = Bun.spawn([process.execPath, import.meta.path, 'writer', '--dir', dir, '--seconds', String(seconds)], { stdout: 'pipe', stderr: 'inherit' });
      childPid = child.pid;
      writer = new Response(child.stdout).text().then((text) => JSON.parse(text.trim().split('\n').at(-1)!));
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000)); // let the writer open its stores first
    const readers = readStores(dir, true);
    stores = readers.stores;
    let childRssPeak = 0;
    const sampler = childPid ? setInterval(() => { childRssPeak = Math.max(childRssPeak, rss(childPid) ?? 0); }, 1000) : undefined;
    const measured = await front(stores, seconds - 4);
    if (sampler) clearInterval(sampler);
    const result = await writer;
    for (const store of stores) store.close();
    readers.ledger.close();
    console.log(JSON.stringify({ mode, seconds, ...measured, writer: { ...result, ...(childPid ? { writer_rss_peak_mb: childRssPeak } : {}) },
      process_rss_mb: rss() }));
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
  console.error('usage: engine-split-bench.ts seed|run [--items N] [--mode same|thread|process] [--seconds S] [--dir PATH]');
  process.exit(2);
}
