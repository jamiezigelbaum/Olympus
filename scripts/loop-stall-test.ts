#!/usr/bin/env bun
/**
 * Synthetic engine-freeze gate (step-back section 7).
 *
 * build --dir PATH [--items 600000] [--chunks-per-item 1]
 * run --dir PATH [--seconds 300] [--memory-max 2G]
 *
 * Build once, outside the cap. Run on Linux under:
 * systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0 -- bun scripts/loop-stall-test.ts run --dir PATH --memory-max 2G
 * For the warm-cache regression use MemoryMax=8G and run --memory-max 8G.
 * Sparta: 28 GiB RAM (~15 GB free), 681k items / 629k chunks, 4.9 GB
 * Personal + 3.6 GB Private + 4.6 GB ledger + 0.7 GB sniffer. Recount
 * read 265 GB via pread (rchar), only 4.7 GB from disk (read_bytes),
 * across 130+ open SQLite files (28-46 per corpus/process, 7 corpora).
 * Preserve SQLite's default connection page caches: the 8G run must fail
 * on the affected engine even when the OS page cache is warm.
 * The measured interval includes cold engine startup (hidden-set construction),
 * then concurrent sync, embedding, judge/settle, paced recount and front Asks.
 * Owner: Olympus engine maintainers. Runtime: 5 minutes, excluding one-time
 * seed. No false-positive allowance; repeat only with unrelated load recorded.
 * Retire when no engine main thread reads SQLite. The SQL allowance starts
 * empty and may only shrink. Synthetic data and loopback stub HTTP only.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import type { AnalystModel } from '../src/core/analyst.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { olympusDataRoot } from '../src/core/olympus-layout.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { openConnectorStore, openTierLedger, storageAccountForCorpus } from '../src/core/source-storage.ts';
import type { LocalConnectorStore, ConnectorStoreItemCopy } from '../src/workers/connector-store/local-index.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { classifyItemTiers, type TierDecision, type TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { defaultFileExtractionJobsDbPath } from '../src/workers/file-extraction/job-names.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { startPacedStatusRecount } from '../src/workers/engine/status-recount.ts';
import { createWorkerFetch } from '../src/core/worker-transport.ts';

const VERSION = 5;
// Sized from 10k-item seeds to match Telegram's store bytes per identity.
const CHUNK_WORDS = 168;
const LEDGER_PASSES = 4;
const LEDGER_REASON_BYTES = 1024;
const MODEL = 'loop-stall-384';
const DIMENSION = 384;
const DOMAINS = ['internal', 'secure_local', 'public_safe'] as const;
const corpus = (domain: string) => `${domain}.fixture.loop-stall`;
const identity = (id: number | string) => ({ family: 'file' as const, provider: 'fixture', accountScope: 'synthetic', providerItemId: String(id), localItemId: `synthetic:${id}`, sourceVersion: '1' });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const words = 'orchard harbor ledger quarterly invoice policy coverage renewal clause schedule deductible premium claim travel notes meeting draft budget review letter contract summary report plan'.split(' ');
function random(seed: number): () => number {
  let n = seed >>> 0 || 1;
  return () => { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; return (n >>> 0) / 4294967296; };
}
function text(id: number, chunk: number): string {
  const next = random(id * 7919 + chunk + 1);
  return `Synthetic orchard ${id} part ${chunk}. ` + Array.from({ length: CHUNK_WORDS }, () => words[Math.floor(next() * words.length)]).join(' ');
}
function vector(seed: number): number[] {
  const next = random(seed + 17);
  const v = Array.from({ length: DIMENSION }, () => next() - 0.5);
  const norm = Math.hypot(...v);
  return v.map(x => x / norm);
}
const embedder: SourceEmbeddingProvider = {
  provider: 'openai-compatible', backend: 'local', modelId: MODEL, dimension: DIMENSION, configHash: 'synthetic-v1', epochId: 'synthetic-v1',
  async embed(inputs) { return inputs.map(input => vector(input.text.length)); },
};
function environment(dir: string): Record<string, string> {
  const home = join(dir, `home-v${VERSION}`);
  return { HOME: home, XDG_DATA_HOME: join(home, 'd'), XDG_STATE_HOME: join(home, 's'), XDG_CONFIG_HOME: join(home, 'c'), NODE_ENV: 'test' };
}
const dataDir = (dir: string) => olympusDataRoot(environment(dir));
const storePath = (dir: string, domain: string) => join(dataDir(dir), `${domain}.sqlite`);
const ledgerPath = (dir: string) => join(dataDir(dir), 'set.tier-ledger.sqlite');
const account = { sourceId: 'fixture.loop-stall' };
function db(object: unknown): Database { return (object as { db: Database }).db; }
function openStores(dir: string) {
  const env = environment(dir);
  const ledger = openTierLedger(account, { dbPath: ledgerPath(dir) }, env);
  const stores = DOMAINS.map(domain => {
    const options = { dbPath: storePath(dir, domain), corpusId: corpus(domain), family: 'file' as const, trustDomain: domain, tierLedger: ledger };
    return openConnectorStore(storageAccountForCorpus(options), options, env);
  });
  return { ledger, stores };
}
const placement = () => buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' });
function connector(ids: number[], chunkCount = 1): SourceConnector {
  const item = (id: number): RawItem => ({ identity: identity(id), mimeType: 'text/plain', content: { kind: 'text', text: Array.from({ length: chunkCount }, (_, c) => text(id, c)).join('\n\n') },
    metadata: { name: `orchard-${id}.txt`, locatorUri: `/synthetic/${id % 100}/orchard-${id}.txt` }, fetchedAt: new Date().toISOString() });
  return { id: 'loop-stall-sync', family: 'file', async authenticate() {},
    async *listItems() { for (let at = 0; at < ids.length; at += 50) yield { items: ids.slice(at, at + 50).map(item), done: at + 50 >= ids.length }; },
    async fetchItem(id) { return item(Number(id.split(':').at(-1))); }, classificationSignals(item) { return { title: String(item.metadata.name), path: String(item.metadata.locatorUri) }; } };
}
function baseDecision(): TierDecision {
  return { ...classifyItemTiers({ signals: {}, text: 'Ordinary synthetic orchard notes.' }), metadataTier: 'private', contentTier: 'private',
    decidedBy: 'sniffer', state: 'current', contentRead: true, metadataPending: false, contentPending: false, reasons: ['content:sniffer:synthetic:personal'] };
}
function tierSet(stores: LocalConnectorStore[], ledger: ReturnType<typeof openTierLedger>, sniffer?: TierSniffer) {
  return new TieredStoreSet({ setId: 'loop-stall', ledger,
    legs: stores.map(store => ({ store, corpusId: store.corpusId, trustDomain: store.trustDomain })),
    tierClassification: { ...(sniffer ? { sniffer } : {}), rules: [{ id: 'new-synthetic-rule', tier: 'secure', strength: 'force', match: { kind: 'pathPrefix', value: '/synthetic/99/' } }] },
    namesOnlyByOwner: path => path.startsWith('/synthetic/1/'),
  });
}

async function build(dir: string, items: number, chunks: number): Promise<void> {
  const shape = { version: VERSION, items, chunksPerItem: chunks, chunkWords: CHUNK_WORDS, dimension: DIMENSION, seed: 99991, secureFraction: 0.4, ledgerPasses: LEDGER_PASSES, ledgerReasonBytes: LEDGER_REASON_BYTES };
  const marker = join(dir, 'shape.json');
  if (existsSync(marker)) {
    const saved = JSON.parse(readFileSync(marker, 'utf8'));
    if (saved.shape.version === VERSION) {
      if (JSON.stringify(saved.shape) !== JSON.stringify(shape)) throw new Error('Shape differs; use a new synthetic folder. Existing fixtures are never silently replaced.');
      for (const path of saved.files as string[]) if (!existsSync(join(dir, path))) throw new Error(`Incomplete fixture: ${path}`);
      console.log(JSON.stringify({ phase: 'build', reused: true, ...saved })); return;
    }
    // Versioned homes rebuild automatically without deleting an older fixture.
    console.error(`Rebuilding shape v${saved.shape.version} as v${VERSION}; retaining the previous synthetic home.`);
  }
  // A build stopped part way (two gate runs were stopped 10 minutes in, 15-16 Nov 2026) leaves this version's synthetic home
  // without its marker. It holds only this script's own seed, so it is cleared and built again rather than blocking every run.
  if (existsSync(storePath(dir, 'internal'))) {
    console.error(`Clearing an unfinished v${VERSION} synthetic home and building it again.`);
    rmSync(environment(dir).HOME!, { recursive: true, force: true });
  }
  mkdirSync(dataDir(dir), { recursive: true });
  const started = Date.now();
  const { stores, ledger } = openStores(dir);
  const jobs = new LocalFileExtractionJobStore(defaultFileExtractionJobsDbPath(environment(dir)));
  try {
    const big = stores[0]!;
    const secure = stores[1]!;
    // Product sync creates the template and its embedding authority. Copies below
    // go through importItemCopy, exactly as tier moves do, never raw INSERTs.
    await big.syncFromConnector(connector([-1], 1), { fetchContent: true, placement });
    await big.embedChunks({ provider: embedder, limit: 10 });
    const template = big.exportItemCopy(identity(-1))!;
    if (!template.vectors.length) throw new Error('Template has no vector authority');
    for (const store of stores) store.bindTierSet(ledger);
    const set = tierSet(stores, ledger);
    const order = Array.from({ length: items }, (_, i) => i);
    const next = random(shape.seed);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
    const base = baseDecision();
    let unreadable = 0;
    // A synthetic fixture built once and kept: no fsync per batch, and larger batches. On Sparta's busy disk the build made
    // 230k of 600k items in the 60 minutes it had (cloud-job 43786974268), most of it waiting on commits.
    for (const handle of [ledger, ...stores]) db(handle).exec('PRAGMA synchronous = OFF');
    for (let from = 0; from < items; from += 2_000) {
      db(ledger).transaction(() => db(big).transaction(() => db(secure).transaction(() => {
        for (const id of order.slice(from, from + 2_000)) {
          const parts = Array.from({ length: chunks }, (_, chunkIndex) => {
            const boundedText = text(id, chunkIndex);
            const contentHash = hash(boundedText);
            return { chunkIndex, boundedText, contentHash, embeddingInputHash: contentHash };
          });
          const embedding = new Uint8Array(new Float32Array(vector(id)).buffer);
          const copy: ConnectorStoreItemCopy = { ...template, identity: identity(id),
            columns: { ...template.columns, provider_item_id: String(id), local_item_id: identity(id).localItemId,
              title: `orchard-${id}.txt`, locator_uri: `/synthetic/${id % 100}/orchard-${id}.txt`, search_text: parts[0]!.boundedText,
              parent_local_item_id: id % 10 === 5 ? identity(id - 1).localItemId : null },
            chunks: parts, vectors: parts.map(part => ({ chunkIndex: part.chunkIndex, modelId: MODEL, contentHash: part.contentHash, embedding })) };
          // 60/40 Personal/Private by identity; both legs contain full text and vectors.
          const destination = id % 10 >= 6 ? secure : big;
          const imported = destination.importItemCopy(copy, { trustTier: destination === secure ? 'S4' : 'S3', syncConnectorId: 'loop-stall-build', vectorProvider: embedder, sourceTextCurrent: true });
          if (imported.vectorsCopied !== chunks) throw new Error('Seed lost vectors');
          const metadataOnly = id % 20 < 2;
          const held = id % 20 === 2;
          const decision: TierDecision = { ...base, ...(destination === secure ? { metadataTier: 'secure', contentTier: 'secure' } : {}), ...(metadataOnly ? { contentRead: false, contentTier: 'secure', reasons: ['content:sniffer:synthetic:fail_safe:unread'] } : {}),
            ...(held ? { contentPending: true, state: 'pending', contentTier: 'secure', reasons: ['content:sniffer:old:undecided'] } : {}) };
          const plan = { copies: [{ corpusId: destination.corpusId, trustDomain: destination.trustDomain, layers: metadataOnly ? 'metadata' as const : 'both' as const }], embedHold: held || metadataOnly };
          // Real routed decisions populate one tier_items row plus history per
          // identity. Content-free synthetic reason codes give the ledger real
          // multi-GB live pages, not a padding table that scans never touch.
          for (let pass = 0; pass < LEDGER_PASSES; pass++) {
            const reason = `content:sniffer:synthetic:pass-${pass}:` + hash(String(id)).repeat(Math.ceil(LEDGER_REASON_BYTES / 64)).slice(0, LEDGER_REASON_BYTES);
            ledger.recordRoutedPlacement(identity(id), { ...decision, reasons: [...decision.reasons, reason] }, plan);
          }
          if (id % 20 === 3) ledger.recordRoutedPlacement(identity(id), { ...base, metadataTier: 'secure', contentTier: 'secure' }, set.placementFor({ ...base, metadataTier: 'secure', contentTier: 'secure' }));
          if (id % 100 === 0) {
            const queued = jobs.enqueue({ refs: [{ ...identity(id), corpusId: destination.corpusId, approvedScopeKey: '/synthetic', sizeBytes: 100, name: `orchard-${id}.txt` }], extractorKind: 'synthetic', extractorVersion: '1', maxBytesPerFile: 1 });
            // A product size refusal is settled-unreadable, with no lease needed.
            // sizeBytes on the reference makes enqueue settle it immediately.
            if (!queued.jobRefs.length) throw new Error('Missing job row');
            unreadable++;
          }
        }
      })())())();
      if (from % 10_000 === 0) console.error(`seed ${from}/${items}`);
      await Bun.sleep(0);
    }
    for (let i = 2; i < stores.length; i++) await stores[i]!.syncFromConnector(connector([items + i], 1), { fetchContent: true, placement: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: DOMAINS[i]! }) });
    ledger.setOverride(identity(0), { kind: 'tier', tier: 'secure' });
    ledger.clearOverride(identity(0));
    big.tombstoneCopy(identity(-1), { connectorId: 'loop-stall-build' });
    console.error(`seeded ${items} items, ${items * chunks} chunks/vectors, ${unreadable} extraction jobs`);
  } finally { jobs.close(); for (const store of stores) store.close(); ledger.close(); }
  // The build writes with synchronous=OFF and leaves multi-GB WALs (6.4 GB on the ledger, gate run 43832739175); a box in use
  // keeps them small. Fold them in so a run starts from the shape an installed engine has.
  truncateWals(dir);
  const files = readdirSync(dataDir(dir)).filter(name => name.endsWith('.sqlite')).map(name => relative(dir, join(dataDir(dir), name)));
  const fileBytes = Object.fromEntries(files.map(path => [path, statSync(join(dir, path)).size]));
  const bytes = Object.values(fileBytes).reduce((n, size) => n + size, 0);
  const receipt = { shape, files, file_bytes: fileBytes, bytes, build_ms: Date.now() - started };
  writeFileSync(marker, JSON.stringify(receipt));
  console.log(JSON.stringify({ phase: 'build', reused: false, ...receipt }));
}

/** The only engine hook: attaches synthetic work to the actual engine loop. */
export async function attachEngineFixture(stores: LocalConnectorStore[], role: string) {
  const dir = process.env.OLYMPUS_LOOP_STALL_DIR!;
  const expected = DOMAINS.map(corpus);
  const selected = expected.map(id => stores.find(store => store.corpusId === id));
  if (selected.some(store => !store)) throw new Error('Loop-stall fixture did not mount all three stores');
  const mounted = selected as LocalConnectorStore[];
  const ledger = openTierLedger(account, { dbPath: ledgerPath(dir), readOnly: role === 'front' }, process.env);
  const installed = new InstalledTierClassification({ env: process.env, lane: BUILT_IN_SNIFFER_LANE, readOnly: role === 'front' });
  tierSet(mounted, ledger, role === 'background' ? installed.forLedger(ledger.dbPath).sniffer : undefined);
  const endpoint = process.env.OLYMPUS_LOOP_STALL_MODEL_URL!;
  const answerModel: AnalystModel = { async complete(request) {
    const response = await fetch(`${endpoint}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }] }), signal: request.signal ?? null });
    const body = await response.json() as { choices: Array<{ message: { content: string } }> };
    return { text: body.choices[0]!.message.content, modelId: 'synthetic' };
  } };
  let stopped = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  let service: TierSnifferService | undefined;
  let jobs: LocalFileExtractionJobStore | undefined;
  const counts = { sync_items: 0, embed_chunks: 0, embed_passes_started: 0, judge_passes: 0, recounts: 0, recounts_started: 0, failures: [] as string[] };
  const report = () => writeFileSync(join(dir, 'workloads.json'), JSON.stringify(counts));
  const guarded = (label: string, work: () => Promise<void>) => {
    let busy = false;
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try { await work(); } catch (error) { counts.failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
      finally { busy = false; report(); }
    };
    void tick();
    return tick;
  };
  if (role === 'background') {
    jobs = new LocalFileExtractionJobStore(defaultFileExtractionJobsDbPath(process.env));
    for (const store of mounted) store.setExtractionOutcomeProbe(id => jobs!.itemExtractionOutcome(id));
    const starter = setInterval(() => {
      if (!existsSync(join(dir, 'start'))) return;
      clearInterval(starter);
      ledger.setOverride(identity(0), { kind: 'tier', tier: 'secure' });
      ledger.clearOverride(identity(0));
      ledger.writeMeta('owner_rules_sweep', '');
      service = new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE, model: answerModel, stores: () => mounted,
        classificationLedgerPath: join(dir, 'classification.jsonl'), autoApproveBuiltIn: true, maxCallsPerPass: 50,
        extractionState: id => jobs!.itemExtractionState(id), log: line => console.error(line) });
      let id = 1_000_000_000 + Date.now();
      const sync = guarded('sync', async () => {
        for (const store of mounted) {
          await store.syncFromConnector(connector(Array.from({ length: store === mounted[0] ? 50 : 1 }, () => id++)), { fetchContent: true, tierClassification: { sniffer: { id: 'synthetic-judged', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary' }) } }, placement: () => buildSourceSensitivity({ trustTier: store.trustDomain === 'secure_local' ? 'S4' : store.trustDomain === 'internal' ? 'S3' : 'S2', trustDomain: store.trustDomain }) });
          if (store === mounted[0]) counts.sync_items += 50;
        }
      });
      const embed = guarded('embedding', async () => { counts.embed_passes_started++; report(); for (const store of mounted) counts.embed_chunks += (await store.embedChunks({ provider: embedder, limit: 250 })).chunksEmbedded; });
      const judge = guarded('judge', async () => { await service!.runOnce(); counts.judge_passes++; });
      // Uses the product pacer in addition to the engine's own status snapshot
      // recount, ensuring every changed fixture store reaches prepareStatusCounts.
      const recount = startPacedStatusRecount({ holds: () => stopped, recount: async () => {
        counts.recounts_started++; report();
        try {
          for (const store of mounted) { await store.prepareStatusCounts(); await store.statusOffThread(); }
          counts.recounts++;
        } catch (error) { counts.failures.push(`recount: ${error instanceof Error ? error.message : String(error)}`); }
        report();
      } });
      stopRecount = () => recount.stop();
      timers.push(setInterval(sync, 1000), setInterval(embed, 250), setInterval(judge, 1000));
      report();
    }, 50);
    timers.push(starter);
  }
  let stopRecount = () => {};
  return { answerModel, stop() { stopped = true; for (const timer of timers) clearInterval(timer); stopRecount(); service?.stop(); installed?.close(); jobs?.close(); ledger.close(); } };
}

interface Loop { max_ms: number; over_budget: number; beats: number }
export function gate(input: { background: Loop; front: Loop; slow_sql: Array<{ sql_id: string }>; workload_ok: boolean }, allowed: readonly string[]) {
  return input.workload_ok && input.background.beats > 0 && input.front.beats > 0 && input.background.max_ms < 250 && input.front.max_ms < 100
    && input.slow_sql.every(row => allowed.includes(row.sql_id));
}
export function memoryMaxBytes(value: string): number {
  const match = /^(\d+)([KMGT]?)$/i.exec(value);
  const bytes = match ? Number(match[1]) * 1024 ** (['', 'K', 'M', 'G', 'T'].indexOf(match[2]!.toUpperCase())) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Invalid --memory-max; use bytes or a K/M/G/T suffix (for example 2G or 8G).');
  return bytes;
}
function capped(memoryMax: number): boolean {
  try {
    const relative = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::'))!.slice(3);
    const root = join('/sys/fs/cgroup', relative);
    return Number(readFileSync(join(root, 'memory.max'), 'utf8')) <= memoryMax && readFileSync(join(root, 'memory.swap.max'), 'utf8').trim() === '0';
  } catch { return false; }
}
/**
 * Pressure stall totals (PSI, microseconds) for the host and for this run's own cgroup, so a slow statement can be told
 * apart as a disk or memory wait (the host's or the cap's) rather than a lock wait or a plan. Undefined where not readable.
 */
type PressureTotals = Record<string, number>;
function readPressure(): PressureTotals {
  const totals: PressureTotals = {};
  const parse = (scope: string, kind: string, path: string) => {
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const match = /^(some|full) .*total=(\d+)/.exec(line);
        if (match) totals[`${scope}_${kind}_${match[1]}`] = Number(match[2]);
      }
    } catch { /* not readable here */ }
  };
  for (const kind of ['io', 'memory', 'cpu']) parse('host', kind, `/proc/pressure/${kind}`);
  try {
    const relative = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::'))!.slice(3);
    for (const kind of ['io', 'memory']) parse('cgroup', kind, join('/sys/fs/cgroup', relative, `${kind}.pressure`));
  } catch { /* no cgroup v2 */ }
  return totals;
}
/** One sample a second: milliseconds stalled in that second, per scope and kind. Returns the samples and a stop. */
function samplePressure(): { samples: Array<{ at: string } & Record<string, number | string>>; stop(): void } {
  const samples: Array<{ at: string } & Record<string, number | string>> = [];
  let last = readPressure();
  const timer = setInterval(() => {
    const now = readPressure();
    const sample: { at: string } & Record<string, number | string> = { at: new Date().toISOString() };
    for (const [key, total] of Object.entries(now)) if (last[key] !== undefined) sample[key] = Math.round((total - last[key]!) / 1000);
    samples.push(sample);
    last = now;
  }, 1000);
  return { samples, stop: () => clearInterval(timer) };
}
/** The worst second and the seconds with any stall at or over 100 ms, per key. */
function pressureSummary(samples: Array<{ at: string } & Record<string, number | string>>) {
  const keys = [...new Set(samples.flatMap(sample => Object.keys(sample).filter(key => key !== 'at')))];
  const worst = Object.fromEntries(keys.map(key => [key, Math.max(0, ...samples.map(sample => Number(sample[key] ?? 0)))]));
  const stalled = samples.filter(sample => keys.some(key => Number(sample[key] ?? 0) >= 100));
  return { readable: keys.length > 0, worst_ms_per_second: worst, seconds_sampled: samples.length, seconds_with_stall_100ms: stalled.length, stalled_seconds: stalled.slice(0, 300) };
}
/** Each fixture file's WAL size in bytes (0 when it has none), so a WAL the fixture carries in shows apart from one a run builds. */
function walSizes(dir: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const name of readdirSync(dataDir(dir)).filter(entry => entry.endsWith('.sqlite'))) {
    try { sizes[name] = statSync(join(dataDir(dir), `${name}-wal`)).size; } catch { sizes[name] = 0; }
  }
  return sizes;
}
/** A WAL over this at the end of a run fails the gate: the engine let it grow instead of checkpointing. */
const WAL_END_LIMIT_BYTES = 64 * 1024 * 1024;
/** A background-lane read held open longer than this fails the gate; shared-lane ones are listed only. */
const BACKGROUND_READ_LIMIT_MS = 2_000;
/** Folds the stores' and the ledger's WALs into their databases and truncates them to zero, through the product's own opens. */
function truncateWals(dir: string) {
  const { ledger, stores } = openStores(dir);
  try { for (const handle of [ledger, ...stores]) db(handle).query('PRAGMA wal_checkpoint(TRUNCATE)').all(); }
  finally { for (const store of stores) store.close(); ledger.close(); }
}
/**
 * "First boot after an upgrade": leaves bytes of committed, uncheckpointed WAL on the ledger, the way an update that rewrote
 * a store leaves it. A child (the pad-wal command) writes and drops a pad table with checkpoints off, then is killed so
 * close never folds it in.
 */
function leaveLargeWal(dir: string, bytes: number) {
  spawnSync(process.execPath, [import.meta.path, 'pad-wal', '--dir', dir, '--wal-mb', String(Math.ceil(bytes / 1048576))], { stdio: 'inherit' });
  const size = statSync(`${ledgerPath(dir)}-wal`).size;
  if (size < bytes) throw new Error(`Could not leave a ${bytes}-byte WAL on the ledger (have ${size})`);
}
function padWal(dir: string, megabytes: number): never {
  const { ledger, stores } = openStores(dir);
  for (const store of stores) store.close();
  const handle = db(ledger);
  handle.exec('PRAGMA wal_autocheckpoint = 0');
  handle.exec('CREATE TABLE IF NOT EXISTS loop_stall_wal_pad (b BLOB)');
  const insert = handle.prepare('INSERT INTO loop_stall_wal_pad VALUES (randomblob(1048576))');
  for (let i = 0; i < megabytes; i++) insert.run();
  handle.exec('DROP TABLE loop_stall_wal_pad');
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
}
/**
 * The IO floor: waits until the host's full IO stall averages under limitMs per second over 10 seconds, so a run measures
 * the engine and not someone else's disk load. Not quiet within maxWaitSeconds means the run is "host busy", not a result.
 */
async function waitForQuietHost(limitMs: number, maxWaitSeconds: number) {
  const started = Date.now();
  const window: number[] = [];
  let last = readPressure();
  if (last.host_io_full === undefined) return { readable: false, quiet: true, waited_s: 0, host_io_full_ms_per_s: null as number | null, limit_ms_per_s: limitMs };
  while (Date.now() - started < maxWaitSeconds * 1000) {
    await Bun.sleep(1000);
    const now = readPressure();
    window.push((now.host_io_full! - last.host_io_full!) / 1000); last = now;
    if (window.length > 10) window.shift();
    const mean = window.reduce((n, v) => n + v, 0) / window.length;
    if (window.length === 10 && mean < limitMs) return { readable: true, quiet: true, waited_s: Math.round((Date.now() - started) / 1000), host_io_full_ms_per_s: Math.round(mean), limit_ms_per_s: limitMs };
  }
  const mean = window.reduce((n, v) => n + v, 0) / Math.max(1, window.length);
  return { readable: true, quiet: false, waited_s: Math.round((Date.now() - started) / 1000), host_io_full_ms_per_s: Math.round(mean), limit_ms_per_s: limitMs };
}
/** The WAL guards: no WAL over 64 MB at the end, and no background-lane read held over 2 s. Shared-lane reads are listed. */
export function sqliteGuards(walAtEnd: Record<string, number>, walLines: readonly string[]) {
  const wal_over_limit = Object.entries(walAtEnd).filter(([, bytes]) => bytes > WAL_END_LIMIT_BYTES).map(([file, bytes]) => ({ file, bytes }));
  const reads = walLines.flatMap(line => {
    const match = /sqlite wal: (\S+) .*oldest_read_ms=(\d+) oldest_read_lane=(\S+) oldest_read_site=(\S+)/.exec(line);
    return match && Number(match[2]) > BACKGROUND_READ_LIMIT_MS ? [{ label: match[1]!, ms: Number(match[2]), lane: match[3]!, site: match[4]! }] : [];
  });
  const longest = (lane: (name: string) => boolean) => [...reads.filter(read => lane(read.lane)).reduce((map, read) => {
    const key = `${read.label} ${read.site}`;
    if ((map.get(key)?.ms ?? 0) < read.ms) map.set(key, read);
    return map;
  }, new Map<string, typeof reads[number]>()).values()].sort((a, b) => b.ms - a.ms);
  const background_reads_over_2s = longest(lane => lane === 'background');
  const other_reads_over_2s = longest(lane => lane !== 'background');
  return { ok: wal_over_limit.length === 0 && background_reads_over_2s.length === 0, wal_over_limit, background_reads_over_2s, other_reads_over_2s };
}
function coldFiles(dir: string) {
  const files = readdirSync(dataDir(dir)).filter(name => name.endsWith('.sqlite'));
  for (const path of files) for (const suffix of ['', '-wal']) {
    const file = join(dataDir(dir), path + suffix);
    if (!existsSync(file)) continue;
    const result = spawnSync('python3', ['-c', 'import os,sys\nf=os.open(sys.argv[1],os.O_RDONLY)\nos.fsync(f)\nos.posix_fadvise(f,0,0,os.POSIX_FADV_DONTNEED)\nos.close(f)', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Cannot evict synthetic pages: ${result.stderr}`);
  }
}
type RunCase = 'steady' | 'boot-after-upgrade';
async function run(dir: string, seconds: number, memoryMax: string, options: { runCase: RunCase; walBytes: number; ioFloorMs: number; ioWaitSeconds: number }) {
  const shape = JSON.parse(readFileSync(join(dir, 'shape.json'), 'utf8')) as { shape: { version: number } };
  if (shape.shape.version !== VERSION) throw new Error('Build the current synthetic fixture shape before running.');
  const isCapped = capped(memoryMaxBytes(memoryMax));
  if (!isCapped) console.error(`WARNING: run is not under MemoryMax<=${memoryMax} and MemorySwapMax=0; this is not a qualified receipt. Use: systemd-run --user --scope -p MemoryMax=${memoryMax} -p MemorySwapMax=0 -- bun scripts/loop-stall-test.ts run --dir ${JSON.stringify(dir)} --memory-max ${memoryMax}`);
  const runDir = mkdtempSync('/tmp/ols-'); // Unix socket path must remain short.
  const metrics = join(runDir, 'metrics'); mkdirSync(metrics);
  for (const name of ['start', 'workloads.json']) rmSync(join(dir, name), { force: true });
  const modelCalls = { judge: 0, answer: 0 };
  const stub = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { messages: Array<{ content: string }> };
    const judging = (body.messages[0]?.content ?? '').includes('privacy classifier');
    if (judging) modelCalls.judge++; else modelCalls.answer++;
    const content = judging ? JSON.stringify({ verdicts: Array.from({ length: 50 }, (_, i) => ({ i: i + 1, tier: 'personal', confidence: 1, category: 'ordinary', ownRecord: false, privateKind: 'none' })) })
      : JSON.stringify({ answer: 'Synthetic orchard notes.', citations: [], unanswered: [] });
    return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  } });
  const portProbe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = portProbe.port; portProbe.stop(true);
  const env = { PATH: process.env.PATH ?? '', ...environment(dir), HOME: runDir, XDG_CONFIG_HOME: join(runDir, 'c'), XDG_STATE_HOME: join(runDir, 's'), XDG_RUNTIME_DIR: runDir,
    OLYMPUS_EMAIL_SOURCE_PORT: String(port), OLYMPUS_WORKER_AUTH_TOKEN: 'synthetic-loop-stall-token',
    OLYMPUS_ENGINE_BACKGROUND_SOCKET: join(runDir, 'background.sock'), OLYMPUS_WORKER_SCHEDULER_ENABLED: 'false',
    OLYMPUS_TIER_SNIFFER_ENABLED: 'false', OLYMPUS_UPDATE_CHECK: 'off', OLYMPUS_BUILT_IN_ANALYST: 'false',
    OLYMPUS_LOOP_STALL_DIR: dir, OLYMPUS_LOOP_STALL_MODEL_URL: `http://127.0.0.1:${stub.port}`,
    OLYMPUS_ENGINE_LOOP_METRICS_DIR: metrics, OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED: 'true',
    OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES: '16000', OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'false',
    OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: JSON.stringify(DOMAINS.map(domain => ({ dbPath: storePath(dir, domain), corpusId: corpus(domain), family: 'file', trustDomain: domain }))),
  };
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const output: Record<string, string> = { background: '', front: '' };
  // The engine's SQLite settings and WAL lines, kept whole (output keeps only its tail), each with when it arrived.
  const sqliteLines: Array<{ at: string; role: string; line: string }> = [];
  const partial: Record<string, string> = { background: '', front: '' };
  const keepSqliteLines = (role: string, text: string) => {
    const lines = (partial[role] + text).split('\n');
    partial[role] = lines.pop() ?? '';
    for (const line of lines) if (line.includes('[olympus] sqlite settings:') || line.includes('[olympus] sqlite wal:') || line.includes('[olympus] sqlite checkpoint:')) sqliteLines.push({ at: new Date().toISOString(), role, line: line.slice(line.indexOf('[olympus] sqlite')).slice(0, 400) });
  };
  const pumps: Promise<void>[] = [];
  const requests: Promise<void>[] = [];
  const forwarded: Array<{ ms: number; status: number; error?: unknown }> = [];
  const asks: Array<{ ms: number; status: number; evidence_ms: unknown }> = [];
  const errors: string[] = [];
  const requestErrors: string[] = [];
  // Steady: every run starts with the WALs folded in, as on a box in use. Boot after upgrade: one large WAL left on the ledger.
  truncateWals(dir);
  if (options.runCase === 'boot-after-upgrade') leaveLargeWal(dir, options.walBytes);
  const host = await waitForQuietHost(options.ioFloorMs, options.ioWaitSeconds);
  if (!host.quiet) {
    const receipt = { phase: 'run', case: options.runCase, sha: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), pass: false, host_busy: true, host, qualified: isCapped, memory_max: memoryMax };
    console.log(JSON.stringify(receipt));
    console.log(`HOST BUSY: host IO stall ${host.host_io_full_ms_per_s} ms/s over ${host.waited_s} s (floor ${host.limit_ms_per_s} ms/s). Not a product result; run again when the host is quiet.`);
    stub.stop(true); rmSync(runDir, { recursive: true, force: true });
    return 'host_busy' as const;
  }
  const started = Date.now();
  let finished = false;
  const pressureSampler = samplePressure();
  let walAtOpen: Record<string, number> = {};
  try {
    walAtOpen = walSizes(dir);
    coldFiles(dir);
    for (const role of ['background', 'front']) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/workers/engine/server.ts')], { env: { ...env, OLYMPUS_WORKER_ENGINE_ROLE: role, OLYMPUS_MAIN_THREAD_SQL_LOG: join(metrics, `${role}.sql.jsonl`) }, stdout: 'pipe', stderr: 'pipe' });
      children.push(child);
      for (const stream of [child.stdout, child.stderr]) pumps.push((async () => { for await (const chunk of stream as ReadableStream<Uint8Array>) { const text = new TextDecoder().decode(chunk); keepSqliteLines(role, text); output[role] = (output[role]! + text).slice(-100_000); } })());
    }
    const deadline = Date.now() + seconds * 1000;
    while (!output.background!.includes('engine background ready') || !output.front!.includes('worker listening')) {
      if (Date.now() >= deadline || children.some(child => child.exitCode !== null)) throw new Error('Engine boot failed or timed out; see last-run.json engine_logs');
      await Bun.sleep(100);
    }
    writeFileSync(join(dir, 'start'), 'start');
    const workerFetch = createWorkerFetch({ platform: 'linux', env });
    const post = async (path: string, body: object) => {
      const start = performance.now();
      const response = await workerFetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${env.OLYMPUS_WORKER_AUTH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(60_000, Math.max(1, deadline - Date.now()))) });
      const json = await response.json() as Record<string, unknown>;
      return { ms: performance.now() - start, status: response.status, json };
    };
    let nextAsk = Date.now(), nextRead = Date.now(), askSequence = 0;
    while (Date.now() < deadline) {
      if (children.some(child => child.exitCode !== null)) throw new Error('Engine exited during measurement');
      if (Date.now() >= nextRead) {
        nextRead += 1000;
        requests.push(post('/v1/source/item/read', { selected_item: { corpus_id: corpus('internal'), family: 'file', provider: 'fixture', account_scope: 'synthetic', provider_item_id: '4', local_item_id: identity(4).localItemId } }).then(result => { forwarded.push({ ms: result.ms, status: result.status, ...(result.status === 200 ? {} : { error: result.json.error }) }); }).catch(error => { requestErrors.push(`forward: ${error.message}`); }));
      }
      if (Date.now() >= nextAsk) {
        nextAsk += 15_000;
        requests.push(post('/v1/source/answer', { question: `What do the synthetic orchard notes say? trial ${askSequence++}`, corpus_ids: [corpus('internal')] }).then(result => {
          const timing = (result.json.audit as { phase_timings?: Record<string, unknown> } | undefined)?.phase_timings;
          asks.push({ ms: result.ms, status: result.status, evidence_ms: timing?.evidence_pack_ms ?? null });
        }).catch(error => { requestErrors.push(`ask: ${error.message}`); }));
      }
      await Bun.sleep(50);
    }
    finished = true;
    await Promise.all(requests);
    // Allow the heartbeat thread to publish the final completed beat.
    await Bun.sleep(125);
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  finally {
    pressureSampler.stop();
    for (const child of children) child.kill('SIGKILL');
    await Promise.all(children.map(child => child.exited)); await Promise.all(pumps);
    await Promise.allSettled(requests);
    stub.stop(true);
  }
  const read = (name: string, fallback: unknown) => { try { return JSON.parse(readFileSync(join(metrics, name), 'utf8')); } catch { return fallback; } };
  const empty: Loop = { max_ms: 0, over_budget: 0, beats: 0 };
  const background = read('background.json', {}).loop_lag ?? empty;
  const front = read('front.json', {}).loop_lag ?? empty;
  const slow_sql = ['background', 'front'].flatMap(role => {
    const path = join(metrics, `${role}.sql.jsonl`);
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => ({ role, ...JSON.parse(line) })) : [];
  });
  let workloads = { sync_items: 0, embed_chunks: 0, embed_passes_started: 0, judge_passes: 0, recounts: 0, recounts_started: 0, failures: [] as string[] };
  if (existsSync(join(dir, 'workloads.json'))) workloads = JSON.parse(readFileSync(join(dir, 'workloads.json'), 'utf8'));
  const workload_ok = finished && errors.length === 0 && workloads.failures.length === 0 && workloads.sync_items > 0 && workloads.embed_passes_started > 0 && workloads.judge_passes > 0 && workloads.recounts_started > 0
    && modelCalls.judge > 0 && asks.some(ask => ask.status === 200 && typeof ask.evidence_ms === 'number') && forwarded.some(read => read.status === 200);
  const allowed = JSON.parse(readFileSync(join(import.meta.dir, 'loop-stall-allowlist.json'), 'utf8')) as string[];
  const walAtEnd = walSizes(dir);
  const walLines = sqliteLines.filter(entry => entry.line.includes('sqlite wal:'));
  const guards = sqliteGuards(walAtEnd, walLines.map(entry => entry.line));
  const pass = gate({ background, front, slow_sql, workload_ok }, allowed) && guards.ok;
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const receipt = { phase: 'run', case: options.runCase, sha, pass, host_busy: false, host, qualified: isCapped, memory_max: memoryMax, elapsed_ms: Date.now() - started, background, front, slow_sql, forwarded, asks, workloads, workload_ok, model_calls: modelCalls, request_errors: requestErrors, errors, pressure: pressureSummary(pressureSampler.samples),
    sqlite: { guards, wal_bytes_at_open: walAtOpen, wal_bytes_at_end: walAtEnd, settings: sqliteLines.filter(entry => entry.line.includes('sqlite settings:')).slice(0, 200),
      checkpoint: sqliteLines.filter(entry => entry.line.includes('sqlite checkpoint:')).slice(0, 2000), wal: walLines.slice(0, 2000) } };
  writeFileSync(join(dir, 'last-run.json'), JSON.stringify({ ...receipt, engine_logs: output }, null, 2));
  console.log(JSON.stringify(receipt));
  console.log(`${pass ? 'PASS' : 'FAIL'} (${options.runCase}): background ${background.max_ms} ms (<250), front ${front.max_ms} ms (<100), ${slow_sql.length} slow SQL statements, workloads ${workload_ok ? 'complete' : 'INCOMPLETE'}, WALs over 64 MB at end ${guards.wal_over_limit.length}, background reads over 2 s ${guards.background_reads_over_2s.length}`);
  rmSync(runDir, { recursive: true, force: true });
  return pass;
}
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const flag = (name: string, fallback?: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1]; };
  const dir = flag('dir');
  const number = (name: string, fallback: string) => { const n = Number(flag(name, fallback)); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid --${name}`); return n; };
  if (dir && command === 'pad-wal') padWal(resolve(dir), number('wal-mb', '2048'));
  if (!dir || !['build', 'run'].includes(command ?? '')) throw new Error('Usage: loop-stall-test.ts build|run --dir PATH [--items N] [--chunks-per-item N] [--seconds N] [--memory-max 2G] [--case steady|boot-after-upgrade] [--wal-mb 2048] [--io-floor-ms 50] [--io-wait-seconds 600]');
  const runCase = flag('case', 'steady') as RunCase;
  if (!['steady', 'boot-after-upgrade'].includes(runCase)) throw new Error('Invalid --case; use steady or boot-after-upgrade');
  if (command === 'build') await build(resolve(dir), number('items', '600000'), number('chunks-per-item', '1'));
  else {
    const result = await run(resolve(dir), number('seconds', '300'), flag('memory-max', '2G')!, { runCase, walBytes: number('wal-mb', '2048') * 1024 * 1024, ioFloorMs: number('io-floor-ms', '50'), ioWaitSeconds: number('io-wait-seconds', '600') });
    // Exit 3 is "host busy": the run did not measure the engine.
    process.exitCode = result === 'host_busy' ? 3 : result ? 0 : 1;
  }
  process.exit(process.exitCode ?? 0);
}
