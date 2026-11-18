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
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync, mkdtempSync, rmSync } from 'node:fs';
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
import { engineStatusSnapshotPath } from '../src/workers/engine-split/runtime.ts';
import { LOOP_LAG_BUCKETS_MS } from '../src/core/engine-heartbeat.ts';
import { controlPathHeadroom, freezeLogLine, summarizeCpuSamples, tracesInStalls } from '../src/workers/control-path-headroom.ts';
import { ownerTierItemId } from '../src/workers/classification/tier-owner-items.ts';
import { DASHBOARD_LOCAL_CONTROL_SESSION_PATH } from '../src/workers/http.ts';

// v6: each build keeps a pristine copy and each run starts from it, so every run has judging to do (plan, 16 Nov 2026).
const VERSION = 6;
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
const pristineDir = (dir: string) => join(dir, `pristine-v${VERSION}`);
/** Copies a data tree (reflinked where the filesystem can). */
function copyTree(from: string, to: string) {
  rmSync(to, { recursive: true, force: true });
  const result = spawnSync('cp', ['-a', '--reflink=auto', from, to], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot copy ${from} to ${to}: ${result.stderr}`);
}
/** Every run starts from the built fixture: judged verdicts are cached by content, so a reused fixture runs out of judging. */
function restorePristine(dir: string) {
  if (!existsSync(pristineDir(dir))) throw new Error(`No pristine copy at ${pristineDir(dir)}; build this fixture again (a v${VERSION} build keeps one).`);
  copyTree(pristineDir(dir), dataDir(dir));
  rmSync(join(dir, 'classification.jsonl'), { force: true });
}
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
      if (!existsSync(pristineDir(dir))) throw new Error(`Incomplete fixture: no pristine copy at ${pristineDir(dir)}`);
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
  copyTree(dataDir(dir), pristineDir(dir));
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
  // A failure keeps its code and first product frames, so a lock error names the connection that gave up.
  const describe = (error: unknown) => {
    if (!(error instanceof Error)) return String(error);
    const code = (error as { code?: unknown }).code;
    const frames = (error.stack ?? '').split('\n').slice(1).map(line => line.trim().replace(/^at /, ''))
      .filter(line => /\/(src|scripts)\//.test(line)).slice(0, 2).map(line => line.replace(/.*\/(src|scripts)\//, '$1/'));
    return `${error.message}${code !== undefined ? ` [${String(code)}]` : ''}${frames.length ? ` @ ${frames.join(' < ')}` : ''}`;
  };
  const counts = { sync_items: 0, embed_chunks: 0, embed_passes_started: 0, judge_passes: 0, recounts: 0, recounts_started: 0, failures: [] as string[] };
  const report = () => writeFileSync(join(dir, 'workloads.json'), JSON.stringify(counts));
  const guarded = (label: string, work: () => Promise<void>) => {
    let busy = false;
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try { await work(); } catch (error) { counts.failures.push(`${label}: ${describe(error)}`); }
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
        } catch (error) { counts.failures.push(`recount: ${describe(error)}`); }
        report();
      } });
      stopRecount = () => recount.stop();
      timers.push(setInterval(sync, 1000), setInterval(embed, 250), setInterval(judge, 1000));
      report();
    }, 50);
    timers.push(starter);
  }
  let stopRecount = () => {};
  return { answerModel, storePaths: mounted.map(store => store.dbPath), stop() { stopped = true; for (const timer of timers) clearInterval(timer); stopRecount(); service?.stop(); installed?.close(); jobs?.close(); ledger.close(); } };
}

interface Loop { max_ms: number; over_budget: number; beats: number; buckets?: number[] }
const ROLES = ['background', 'front'] as const;
type Role = typeof ROLES[number];
const READY_LOG: Record<Role, string> = { background: 'engine background ready', front: 'worker listening' };
const BEAT_MS = 25;
const CPU_FLUSH_MS = 30_000;
const FINAL_SAMPLE_WAIT_MS = 2_000;
type Beat = { startMs: number; endMs: number };
type SampledBeat = Beat & { site: string };
type CpuSummary = ReturnType<typeof summarizeCpuSamples>;
type CpuTraces = Parameters<typeof summarizeCpuSamples>[0];
type CpuSources = Parameters<typeof summarizeCpuSamples>[2];
type CpuRow = { at: string; freezes: CpuSummary & { count: number; totalMs: number; maxMs: number }; beat_sites: SampledBeat[] };
const holdMs = (beat: Beat) => beat.endMs - beat.startMs;
const beatBudgetMs = (role: Role) => role === 'front' ? 100 : 250;
const afterReady = (beat: Beat, readyAt: number | undefined) => readyAt !== undefined && beat.startMs >= readyAt;
const nowMs = () => performance.timeOrigin + performance.now();

function worstBeat(beats: readonly Beat[]): Beat | undefined {
  return beats.reduce<Beat | undefined>((worst, beat) => !worst || holdMs(beat) > holdMs(worst) ? beat : worst, undefined);
}

export function sampledBeatSite(beat: Beat, traces: CpuTraces, offset: number, sources?: CpuSources): SampledBeat | undefined {
  const frames = summarizeCpuSamples(tracesInStalls(traces, [beat], offset), undefined, sources);
  // A product frame names the caller when the leaf is SQLite or the runtime.
  const site = frames.total.find(([frame]) => / \S+\.ts:\d+/.test(frame) && !frame.includes('main-thread-sql-trace') && !frame.includes('bun:'))?.[0] ?? frames.self[0]?.[0];
  return site ? { ...beat, site } : undefined;
}

export function summarizeBeats(role: Role, beats: readonly Beat[], samples: readonly SampledBeat[], timing: { readyAt?: number; spawnedAt: number; stoppedAt: number }) {
  const { readyAt, spawnedAt, stoppedAt } = timing;
  const before = beats.filter(beat => !afterReady(beat, readyAt));
  const after = beats.filter(beat => afterReady(beat, readyAt));
  const buckets = Array<number>(LOOP_LAG_BUCKETS_MS.length + 1).fill(0);
  for (const beat of after) {
    const bucket = LOOP_LAG_BUCKETS_MS.findIndex(edge => holdMs(beat) < edge);
    buckets[bucket < 0 ? LOOP_LAG_BUCKETS_MS.length : bucket]!++;
  }
  // A process killed while held cannot publish the final tick. Its open beat
  // contributes to the worst and over-budget counts; the histogram uses completed beats.
  const openStart = Math.max(beats.at(-1)?.endMs ?? spawnedAt, readyAt ?? spawnedAt) + BEAT_MS;
  const scoredBeats = [...after];
  if (openStart < stoppedAt) {
    const openBeat = { startMs: openStart, endMs: stoppedAt };
    (afterReady(openBeat, readyAt) ? scoredBeats : before).push(openBeat);
  }
  const worst = worstBeat(scoredBeats);
  const preReady = worstBeat(before);
  const sites = new Map(samples.map(sample => [sample.startMs, sample]));
  const siteOf = (beat: Beat | undefined) => {
    const sample = beat && sites.get(beat.startMs);
    return sample && sample.endMs === beat?.endMs ? sample.site : 'unsampled';
  };
  const over1s = scoredBeats.filter(beat => holdMs(beat) > LOOP_STALL_LIMIT_MS);
  const table = new Map<string, { site: string; count: number; total_s: number; worst_ms: number }>();
  for (const beat of over1s) {
    const site = siteOf(beat);
    const entry = table.get(site) ?? { site, count: 0, total_s: 0, worst_ms: 0 };
    entry.count++;
    entry.total_s += holdMs(beat) / 1000;
    entry.worst_ms = Math.max(entry.worst_ms, holdMs(beat));
    table.set(site, entry);
  }
  return {
    loop: {
      max_ms: worst ? holdMs(worst) : 0,
      over_budget: scoredBeats.filter(beat => holdMs(beat) >= beatBudgetMs(role)).length,
      beats: after.length,
      buckets,
      over_1s: over1s.length,
      worst_site: siteOf(worst),
      pre_ready_ms: preReady ? holdMs(preReady) : 0,
      pre_ready_site: siteOf(preReady),
      spawn_to_ready_ms: readyAt === undefined ? null : Math.round(readyAt - spawnedAt),
    },
    sites: [...table.values()].map(entry => ({ ...entry, total_s: Math.round(entry.total_s * 10) / 10 })).sort((a, b) => b.total_s - a.total_s),
  };
}

/** Preloaded in the engine subprocess so both clocks run during startup. */
export function measureEngine(role: Role, path: string, cpuPath: string,
  samplingProfilerStackTraces?: () => { traces?: CpuTraces; sources?: CpuSources },
) {
  // The harness drains this profiler itself so it can keep each sample's beat.
  process.env.OLYMPUS_CPU_SAMPLE_LOG = 'off';
  const fd = openSync(`${path}.beats.jsonl`, 'w', 0o600);
  let expected = performance.timeOrigin + BEAT_MS;
  let lastFlush = nowMs();
  let readyAt: number | undefined;
  let pending: Beat[] = [];
  let flushRequested = false;
  const record = (now: number) => {
    const beat = { startMs: Math.min(expected, now), endMs: now };
    writeSync(fd, JSON.stringify(beat) + '\n');
    pending.push(beat);
    expected = now + BEAT_MS;
  };
  const flush = (now: number) => {
    const beats = pending;
    pending = [];
    flushRequested = false;
    if (!samplingProfilerStackTraces) return;
    // Anchor the profiler's seconds to the beat clock. Spinning briefly gives
    // even an idle interval a fresh trace before draining the profiler.
    const spinUntil = performance.now() + 3;
    while (performance.now() < spinUntil) { /* spin */ }
    const anchor = nowMs();
    const { traces = [], sources } = samplingProfilerStackTraces();
    const newest = traces.reduce((max, trace) => Math.max(max, trace.timestamp ?? -Infinity), -Infinity);
    const offset = newest - anchor / 1000;
    const stalled = beats.filter(beat => holdMs(beat) > LOOP_STALL_LIMIT_MS);
    const selected = new Set([
      ...stalled,
      worstBeat(beats.filter(beat => !afterReady(beat, readyAt))),
      worstBeat(beats.filter(beat => afterReady(beat, readyAt))),
    ]);
    const beat_sites: SampledBeat[] = [];
    for (const beat of selected) {
      if (!beat || !Number.isFinite(newest)) continue;
      const sample = sampledBeatSite(beat, traces, offset, sources);
      if (sample) beat_sites.push(sample);
    }
    const worst = worstBeat(stalled);
    const freezes = {
      count: stalled.length,
      totalMs: Math.round(stalled.reduce((sum, beat) => sum + holdMs(beat), 0)),
      maxMs: worst ? Math.round(holdMs(worst)) : 0,
      ...summarizeCpuSamples(Number.isFinite(newest) ? tracesInStalls(traces, stalled, offset) : [], undefined, sources),
    };
    const at = new Date(now).toISOString();
    appendFileSync(cpuPath, JSON.stringify({ at, pid: process.pid, role, windowMs: Math.round(now - lastFlush), headroom: controlPathHeadroom.snapshot(),
      ...summarizeCpuSamples(traces, undefined, sources), freezes, beat_sites }) + '\n', { mode: 0o600 });
    if (freezes.count) console.error(freezeLogLine(at, role, freezes));
    lastFlush = now;
  };
  const tick = () => {
    const now = nowMs();
    record(now);
    if (flushRequested) {
      flush(now);
      // The last measured tick precedes the shutdown-only profiler work.
      writeFileSync(`${path}.sampled`, String(now), { mode: 0o600 });
    } else if (now - lastFlush >= CPU_FLUSH_MS) flush(now);
  };
  let timer = setInterval(tick, BEAT_MS).unref();
  process.on('SIGUSR2', () => { flushRequested = true; });
  const log = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes(READY_LOG[role])) {
      readyAt = nowMs();
      // Close any boot hold before the ready line, even if the delayed timer
      // callback would have run after it. Restart the timer on this boundary.
      if (readyAt >= expected) record(readyAt);
      expected = readyAt + BEAT_MS;
      clearInterval(timer);
      timer = setInterval(tick, BEAT_MS).unref();
      writeFileSync(`${path}.ready`, String(readyAt), { mode: 0o600 });
      console.log = log;
    }
    log(...args);
  };
}

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  // Only completed lines survive a child killed in the middle of an append.
  return readFileSync(path, 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line) as T);
}

/** The 95th-percentile loop beat, as the upper edge of its histogram bucket ("<= N ms"); undefined without a histogram. */
export function beatP95(loop: Loop): number | undefined {
  const buckets = loop.buckets; if (!buckets?.length) return undefined;
  const total = buckets.reduce((sum, n) => sum + n, 0); if (!total) return undefined;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) { seen += buckets[i]!; if (seen >= total * 0.95) return LOOP_LAG_BUCKETS_MS[i] ?? Infinity; }
  return Infinity;
}
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!);
}
export const LOOP_STALL_LIMIT_MS = 1_000;
// The release bar (owner, 16 Nov 2026, "Finish the boundary in 1.5"): the front never holds its loop 1 s; commands are
// acknowledged under 1 s; the background gates on progress (no beat over 30 s, the work done, no WAL over 64 MB at any point).
// The loop limits use beats after each engine reported ready.
const BACKGROUND_PROGRESS_LIMIT_MS = 30_000;
// Boot after upgrade (owner, 16 Nov 2026 14:35Z: "a 3.7-second freeze after an update is not such a big issue"): the front's
// beats are reported, with a 30 s sanity limit so a real hang still fails.
export function frontLimitMs(runCase: string): number { return runCase === 'boot-after-upgrade' ? BACKGROUND_PROGRESS_LIMIT_MS : LOOP_STALL_LIMIT_MS; }
type GateLoop = Loop & { pre_ready_ms: number };
export function gate(input: { background: GateLoop; front: GateLoop; workload_ok: boolean; wal_ok: boolean; ack_ok: boolean; privacy_restart_ok: boolean; runCase?: string }) {
  return input.workload_ok && input.wal_ok && input.ack_ok && input.privacy_restart_ok && input.background.beats > 0 && input.front.beats > 0
    && input.background.max_ms < BACKGROUND_PROGRESS_LIMIT_MS && input.front.max_ms < frontLimitMs(input.runCase ?? 'steady');
}

/** Run on one throwaway item so a restart never disturbs the measured workload or reopens its large stores. */
export async function privacyClickRestartGate(): Promise<{ pass: boolean; outcome: string; ms: number }> {
  const started = performance.now();
  const result = (pass: boolean, outcome: string) => ({ pass, outcome, ms: Math.round(performance.now() - started) });
  let stage = 'fixture startup';
  try {
    const { privacyRestartFixture } = await import('../test/helpers/privacy-click-restart.ts');
    const fixture = await privacyRestartFixture('private');
    try {
      stage = 'click receipt';
      await fixture.pauseBeforeCommit();
      const ack = await fixture.set();
      const receipt = await ack.json() as { request_id?: string; state?: string };
      if (ack.status !== 202 || receipt.state !== 'pending' || !receipt.request_id) return result(false, `set HTTP ${ack.status}, no pending receipt`);
      const pending = await fixture.status(receipt.request_id);
      const { state } = await pending.json() as { state?: string };
      if (pending.status !== 200 || state !== 'pending' || (await fixture.search()).released || (await fixture.answerRelease()).released) {
        return result(false, `status HTTP ${pending.status}, ${state === 'pending' ? 'pending item released' : 'pending receipt missing'}`);
      }
      stage = 'restart before commit';
      const preCommit = fixture.readStored();
      await fixture.restartFront();
      try {
        const waiting = await fixture.frontWaitingForPrivacyRaise();
        const status = await fixture.status(receipt.request_id);
        const search = await fixture.search();
        const answer = await fixture.answerRelease();
        if (!waiting || preCommit.contentTier !== 'private' || preCommit.overrideTier !== 'private'
          || status.status !== 503 || search.status !== 503 || answer.status !== 503 || search.released || answer.released) {
          return result(false, `pre-commit status HTTP ${status.status}, search HTTP ${search.status}, search released ${search.released}, answer HTTP ${answer.status}, answer released ${answer.released}`);
        }
      } finally {
        fixture.allowCommit();
        await fixture.waitForFrontReady();
      }
      stage = 'reconcile missing receipt';
      const status = await fixture.status(receipt.request_id);
      const { unknown } = await status.json() as { unknown?: boolean };
      const find = await fixture.find();
      const { items } = await find.json() as { items?: Array<{ item_id: string; tier: string; owner_choice?: string; owner_set: boolean }> };
      const saved = fixture.readStored().overrideTier === 'secure'
        && items?.some(item => item.item_id === fixture.itemId && (item.owner_choice || item.tier) === 'Private' && item.owner_set) === true;
      const search = await fixture.search();
      const answer = await fixture.answerRelease();
      const released = search.released || answer.released;
      return result(status.status === 404 && unknown === true && find.status === 200 && saved && search.status === 200 && answer.status === 200 && !released,
        `receipt HTTP 202, restart HTTP 503, status HTTP ${status.status}${unknown ? ' unknown' : ''}, find HTTP ${find.status}, ${saved ? 'saved Private' : 'Private choice unconfirmed'}, released ${released}`);
    } finally {
      await fixture.close();
    }
  } catch (error) {
    return result(false, `${stage} failed (${error instanceof Error ? error.name : 'unknown error'})`);
  }
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
/** Host memory lines that show how much of RAM the file map and swap hold, in MiB (Linux only). */
function readMeminfo(): Record<string, number> {
  const kib: Record<string, number> = {};
  try { for (const line of readFileSync('/proc/meminfo', 'utf8').split('\n')) { const m = /^(\w+):\s+(\d+) kB/.exec(line); if (m) kib[m[1]!] = Number(m[2]); } } catch { return {}; }
  const mib = (value: number | undefined) => Math.round((value ?? 0) / 1024);
  return { mapped_mib: mib(kib.Mapped), cached_mib: mib(kib.Cached), swap_used_mib: mib((kib.SwapTotal ?? 0) - (kib.SwapFree ?? 0)) };
}

/** The run's own cgroup (the 8 GB scope): swap it holds and its file-mapped, file and anonymous memory, in MiB. */
function readCgroupMemory(): Record<string, number | string> {
  try {
    const path = /^0::(.*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
    if (!path) return { error: 'no cgroup v2 path' };
    const base = join('/sys/fs/cgroup', path);
    const read = (name: string) => { try { return readFileSync(join(base, name), 'utf8').trim(); } catch { return undefined; } };
    const stat = Object.fromEntries((read('memory.stat') ?? '').split('\n').map(line => line.split(' ')).filter(parts => parts.length === 2).map(([key, value]) => [key!, Number(value)]));
    const mib = (value: number | string | undefined) => value === undefined || value === 'max' ? value : Math.round(Number(value) / 1024 / 1024);
    const out: Record<string, number | string> = {};
    for (const [key, value] of Object.entries({ swap_current_mib: mib(read('memory.swap.current')), current_mib: mib(read('memory.current')), file_mapped_mib: mib(stat.file_mapped), file_mib: mib(stat.file), anon_mib: mib(stat.anon) })) if (value !== undefined) out[key] = value;
    return out;
  } catch (error) { return { error: String(error).slice(0, 200) }; }
}

/** Per engine role: read() copying (rchar, syscr, read_bytes from /proc/PID/io) from readiness to the end, and the process's own memory at the end. */
function sampleProcessIo(pids: () => Array<{ role: string; pid: number }>, ready: (role: string) => boolean) {
  type Io = Record<string, number>;
  const readIo = (pid: number): Io | undefined => {
    try { return Object.fromEntries(readFileSync(`/proc/${pid}/io`, 'utf8').trim().split('\n').map(line => line.split(': ')).map(([key, value]) => [key!, Number(value)])); } catch { return undefined; }
  };
  const readStatus = (pid: number) => {
    try {
      const text = readFileSync(`/proc/${pid}/status`, 'utf8');
      const mib = (name: string) => Math.round(Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? 0) / 1024);
      return { rss_anon_mib: mib('RssAnon'), rss_file_mib: mib('RssFile'), vm_swap_mib: mib('VmSwap') };
    } catch { return undefined; }
  };
  const state: Record<string, { atReady?: Io; last?: Io; status?: ReturnType<typeof readStatus> }> = {};
  const tick = () => {
    for (const { role, pid } of pids()) {
      const entry = state[role] ??= {};
      const io = readIo(pid);
      if (!io) continue;
      if (!entry.atReady && ready(role)) entry.atReady = io;
      entry.last = io;
      entry.status = readStatus(pid) ?? entry.status;
    }
  };
  const timer = setInterval(tick, 1000);
  return {
    stop: () => { tick(); clearInterval(timer); },
    summary: () => Object.fromEntries(Object.entries(state).map(([role, entry]) => {
      const delta = (key: string) => entry.atReady && entry.last ? (entry.last[key] ?? 0) - (entry.atReady[key] ?? 0) : null;
      return [role, { from_ready: Boolean(entry.atReady), rchar_gb: delta('rchar') === null ? null : Math.round(delta('rchar')! / 1e7) / 100, syscr: delta('syscr'), read_bytes_gb: delta('read_bytes') === null ? null : Math.round(delta('read_bytes')! / 1e7) / 100, at_end: entry.status ?? null }];
    })),
  };
}

/** Host paging counters for the run's delta: pages read in, pages swapped out and in, major faults (Linux only). */
function readVmstat(): Record<string, number> {
  const totals: Record<string, number> = {};
  try {
    for (const line of readFileSync('/proc/vmstat', 'utf8').split('\n')) {
      const [key, value] = line.split(' ');
      if (key && ['pgpgin', 'pgpgout', 'pswpin', 'pswpout', 'pgmajfault'].includes(key)) totals[key] = Number(value);
    }
  } catch { /* not Linux */ }
  return totals;
}

/**
 * The background's main loop thread, sampled by scripts/front-thread-timeline.ts for the whole run, then summarized over each
 * background freeze or held-loop line: time running, waiting for CPU, blocked on page faults, on disk, and the top wait channel.
 */
function startBackgroundTimeline(pid: number, out: string): { stop(): Promise<void> } | undefined {
  if (process.platform !== 'linux') return undefined;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'front-thread-timeline.ts'), '--pid', String(pid), '--out', out, '--seconds', '14400'], { stdout: 'ignore', stderr: 'ignore' });
  return { stop: async () => { child.kill('SIGTERM'); await child.exited; } };
}

function summarizeBackgroundTimeline(timeline: string, freezes: Array<{ at: string; role: string; line: string }>, freezePath: string): unknown[] | string {
  if (!existsSync(timeline)) return 'no timeline was written';
  writeFileSync(freezePath, freezes.filter(entry => entry.role === 'background').map(entry => `${entry.at} ${entry.line}`).join('\n') + '\n');
  const run = spawnSync(process.execPath, [join(import.meta.dir, 'front-thread-timeline.ts'), '--summarize', timeline, '--freezes', freezePath, '--role', 'background'], { encoding: 'utf8', timeout: 120_000 });
  if (run.status !== 0) return `summarize exited ${run.status}: ${(run.stderr || '').slice(-300)}`;
  return run.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return line; } })
    .sort((a: any, b: any) => (b?.window_ms ?? 0) - (a?.window_ms ?? 0)).slice(0, 30);
}

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
/** Peak anonymous memory per engine role, sampled each second from /proc (Linux only), with the second it peaked: a burst and a climb read differently. */
export function sampleAnonMemory(pids: () => Array<{ role: string; pid: number }>, startedAt: () => number): { peaks: Record<string, { peak_anon_mib: number; at_s: number; last_anon_mib: number }>; stop(): void } {
  const peaks: Record<string, { peak_anon_mib: number; at_s: number; last_anon_mib: number }> = {};
  const timer = setInterval(() => {
    for (const { role, pid } of pids()) {
      let kib: number | undefined;
      try { kib = Number(/^RssAnon:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]); } catch { continue; }
      if (!Number.isFinite(kib)) continue;
      const mib = Math.round(kib! / 1024);
      const entry = peaks[role] ??= { peak_anon_mib: 0, at_s: 0, last_anon_mib: 0 };
      entry.last_anon_mib = mib;
      if (mib > entry.peak_anon_mib) { entry.peak_anon_mib = mib; entry.at_s = Math.round((Date.now() - startedAt()) / 1000); }
    }
  }, 1000);
  return { peaks, stop: () => clearInterval(timer) };
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
// Boot after upgrade starts with a WAL padded past the limit by design, so there the peak counts from each file's first line at or
// under the limit (its first rewind); the time that took is reported.
// WAL bar (plan, 16 Nov 2026 17:53Z): after any crossing of 64 MB a file is back at or under it within 60 s; a WAL over 1 GB at any
// point fails; peak and time over 64 MB are reported per store. Lines carry when they arrived ({ at, line }) so time over can be read.
const WAL_BACK_WITHIN_MS = 60_000;
const WAL_HARD_LIMIT_BYTES = 1024 * 1024 * 1024;
type WalLine = string | { at: string; line: string };
export function sqliteGuards(walAtEnd: Record<string, number>, entries: readonly WalLine[], options: { fromFirstLevel?: boolean } = {}) {
  const walLines = entries.map(entry => typeof entry === 'string' ? entry : entry.line);
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
  // The peak, not only the end: closing an engine truncates its WALs, so the end alone can pass a run whose WAL ran away.
  const wal_peak: Record<string, number> = {};
  const level = new Set<string>();
  const overSince = new Map<string, number>();
  const over: Record<string, { crossings: number; over_ms: number; longest_ms: number }> = {};
  let lastAt = 0;
  for (const entry of entries) {
    const line = typeof entry === 'string' ? entry : entry.line;
    const at = typeof entry === 'string' ? NaN : Date.parse(entry.at);
    if (!Number.isNaN(at)) lastAt = Math.max(lastAt, at);
    const match = /sqlite (?:wal held|wal|checkpoint): (\S+) .*?wal_bytes=(\d+)/.exec(line);
    if (!match) continue;
    const label = match[1]!, bytes = Number(match[2]);
    if (options.fromFirstLevel && !level.has(label)) { if (bytes > WAL_END_LIMIT_BYTES) continue; level.add(label); }
    wal_peak[label] = Math.max(wal_peak[label] ?? 0, bytes);
    const row = over[label] ??= { crossings: 0, over_ms: 0, longest_ms: 0 };
    if (bytes > WAL_END_LIMIT_BYTES && !overSince.has(label)) { overSince.set(label, at); row.crossings++; }
    else if (bytes <= WAL_END_LIMIT_BYTES && overSince.has(label)) {
      const ms = at - overSince.get(label)!; overSince.delete(label);
      if (!Number.isNaN(ms)) { row.over_ms += ms; row.longest_ms = Math.max(row.longest_ms, ms); }
    }
  }
  // A crossing still open at the last line has lasted at least until then.
  for (const [label, since] of overSince) {
    const ms = lastAt - since;
    if (!Number.isNaN(ms)) { over[label]!.over_ms += ms; over[label]!.longest_ms = Math.max(over[label]!.longest_ms, ms); }
  }
  const wal_peak_over = Object.entries(wal_peak).filter(([, bytes]) => bytes > WAL_END_LIMIT_BYTES)
    .map(([label, bytes]) => ({ label, bytes, crossings: over[label]?.crossings ?? 0, over_s: Math.round((over[label]?.over_ms ?? 0) / 1000), longest_s: Math.round((over[label]?.longest_ms ?? 0) / 1000) }));
  const wal_slow_back = wal_peak_over.filter(row => row.longest_s * 1000 > WAL_BACK_WITHIN_MS);
  const wal_over_1gb = Object.entries(wal_peak).filter(([, bytes]) => bytes > WAL_HARD_LIMIT_BYTES).map(([label, bytes]) => ({ label, bytes }));
  return { wal_ok: wal_over_limit.length === 0 && wal_slow_back.length === 0 && wal_over_1gb.length === 0, wal_over_limit, wal_peak, wal_peak_over, wal_slow_back, wal_over_1gb, background_reads_over_2s, other_reads_over_2s };
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
async function run(dir: string, seconds: number, memoryMax: string, options: { runCase: RunCase; walBytes: number; ioFloorMs: number; ioWaitSeconds: number; quick?: boolean; sqliteMmap?: 'on' | 'off' | 'bounded' }) {
  const shape = JSON.parse(readFileSync(join(dir, 'shape.json'), 'utf8')) as { shape: { version: number; items: number } };
  if (shape.shape.version !== VERSION) throw new Error('Build the current synthetic fixture shape before running.');
  const isCapped = capped(memoryMaxBytes(memoryMax));
  if (!isCapped) console.error(`WARNING: run is not under MemoryMax<=${memoryMax} and MemorySwapMax=0; this is not a qualified receipt. Use: systemd-run --user --scope -p MemoryMax=${memoryMax} -p MemorySwapMax=0 -- bun scripts/loop-stall-test.ts run --dir ${JSON.stringify(dir)} --memory-max ${memoryMax}`);
  const runDir = mkdtempSync('/tmp/ols-'); // Unix socket path must remain short.
  const metrics = join(runDir, 'metrics'); mkdirSync(metrics);
  const preload = join(runDir, 'profile-engine.mjs');
  // Start taking samples before loading even the harness module and its imports.
  writeFileSync(preload, `
import * as jsc from 'bun:jsc';
jsc.startSamplingProfiler?.();
const { measureEngine } = await import(${JSON.stringify(import.meta.path)});
measureEngine(process.env.OLYMPUS_WORKER_ENGINE_ROLE, process.env.OLYMPUS_LOOP_STALL_PROFILE,
  process.env.OLYMPUS_CPU_SAMPLE_LOG, jsc.samplingProfilerStackTraces);
`);
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
    // The arm's file-map setting for the whole engine (front, background and their read workers inherit it); 'on' is the default.
    ...(options.sqliteMmap && options.sqliteMmap !== 'on' ? { OLYMPUS_SQLITE_MMAP: options.sqliteMmap } : {}),
    OLYMPUS_EMAIL_SOURCE_PORT: String(port), OLYMPUS_WORKER_AUTH_TOKEN: 'synthetic-loop-stall-token',
    OLYMPUS_ENGINE_BACKGROUND_SOCKET: join(runDir, 'background.sock'), OLYMPUS_WORKER_SCHEDULER_ENABLED: 'false',
    OLYMPUS_TIER_SNIFFER_ENABLED: 'false', OLYMPUS_UPDATE_CHECK: 'off', OLYMPUS_BUILT_IN_ANALYST: 'false',
    OLYMPUS_LOOP_STALL_DIR: dir, OLYMPUS_LOOP_STALL_MODEL_URL: `http://127.0.0.1:${stub.port}`,
    OLYMPUS_ENGINE_LOOP_METRICS_DIR: metrics, OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED: 'true',
    OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES: '16000', OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'false',
    // An untimed count of every statement the loops run (each pays for a stack): never set it on a timed run.
    ...(process.env.OLYMPUS_MAIN_THREAD_SQL_SITES ? { OLYMPUS_MAIN_THREAD_SQL_SITES: process.env.OLYMPUS_MAIN_THREAD_SQL_SITES } : {}),
    OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: JSON.stringify(DOMAINS.map(domain => ({ dbPath: storePath(dir, domain), corpusId: corpus(domain), family: 'file', trustDomain: domain }))),
  };
  const children: ReturnType<typeof Bun.spawn>[] = [];
  // A stopped job leaves its engines orphaned and still writing the fixture (43847681247, 16 Nov 2026). Kill any a previous
  // run left, and kill ours when this run is signalled.
  const pidFile = join(dir, 'engine-pids.json');
  try {
    for (const pid of JSON.parse(readFileSync(pidFile, 'utf8')) as number[]) {
      try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('workers/engine/server.ts')) { process.kill(pid, 'SIGKILL'); console.error(`Killed engine ${pid} a stopped run left.`); } } catch { /* gone */ }
    }
  } catch { /* no earlier run */ }
  const killChildren = (signal: NodeJS.Signals) => {
    // Say it was killed and by what (systemd stops a capped scope with SIGTERM when the kernel kills a process in it for memory).
    console.log(`KILLED: the run got ${signal} before it could report${signal === 'SIGTERM' ? ' (under systemd-run, often the scope stopping after an out-of-memory kill)' : ''}. Engine exits: ${children.map(child => child.exitCode ?? child.signalCode ?? 'running').join(', ') || 'none started'}.`);
    for (const role of ['background', 'front']) if (output[role]) console.log(`--- ${role} log tail ---\n${output[role]!.slice(-3000)}`);
    for (const child of children) child.kill('SIGKILL'); process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGHUP' ? 1 : 15)); };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => killChildren(signal));
  const output: Record<string, string> = { background: '', front: '' };
  // The engine's SQLite settings and WAL lines, kept whole (output keeps only its tail), each with when it arrived.
  const sqliteLines: Array<{ at: string; role: Role; line: string }> = [];
  const freezeLines: Array<{ at: string; role: Role; line: string }> = [];
  // The product's per-click trace (ingress, each command POST attempt, control receipt, answer), joined to clicks by id.
  const clickTrace = new Map<string, string[]>();
  const keepEngineLine = (role: Role, line: string) => {
    if (line.includes('[olympus] sqlite settings:') || line.includes('[olympus] sqlite wal:') || line.includes('[olympus] sqlite checkpoint:') || line.includes('[olympus] sqlite wal room:') || line.includes('[olympus] sqlite wal held:')) sqliteLines.push({ at: new Date().toISOString(), role, line: line.slice(line.indexOf('[olympus] sqlite')).slice(0, 400) });
    // Keep each freeze frame and held-loop line outside the bounded engine log tail.
    else if (line.includes('[olympus:click-trace]')) {
      const id = / id=(\S+)/.exec(line)?.[1];
      if (id) { const lines = clickTrace.get(id) ?? []; if (lines.length < 20) lines.push(line.slice(0, 400)); clickTrace.set(id, lines); }
    }
    else if (line.includes('[olympus:control-path]') && (line.includes('freeze frames') || line.includes('loop held for'))) freezeLines.push({ at: new Date().toISOString(), role, line: line.slice(line.indexOf('[olympus:control-path]')).slice(0, 4000) });
  };
  const pumps: Promise<void>[] = [];
  const requests: Promise<void>[] = [];
  const forwarded: Array<{ ms: number; status: number; error?: unknown }> = [];
  const asks: Array<{ ms: number; status: number; evidence_ms: unknown }> = [];
  const acks: Array<{ at: string; ms: number; status: number; loop_held_ms?: number; error?: string }> = [];
  // Each click carries its own id (sent as X-Olympus-Click-Id) and send time, so a late acknowledgement can be matched to
  // the front's ingress, command POST attempts and control receipt in the engine logs (lane 1, 18 Nov).
  const clicks: Array<{ id: string; sent_at: string; ms: number; status: number; received: boolean; request_id?: string; settled_ms?: number; saved?: boolean; error?: unknown }> = [];
  const pendingClicks = new Map<string, { started: number; click: typeof clicks[number] }>();
  const statusAges: Array<{ age_ms: number; loop_held_ms?: number }> = [];
  let enginesStartedAt: number | undefined;
  const timing: Record<Role, { spawnedAt: number; stoppedAt: number; readyAt?: number }> = {
    background: { spawnedAt: 0, stoppedAt: 0 }, front: { spawnedAt: 0, stoppedAt: 0 },
  };
  const readReady = (role: Role) => {
    if (timing[role].readyAt !== undefined) return true;
    const path = join(metrics, `${role}.ready`);
    if (!existsSync(path)) return false;
    const stamp = readFileSync(path, 'utf8');
    if (!stamp) return false;
    timing[role].readyAt = Number(stamp);
    return true;
  };
  const dashReads: Array<{ path: string; ms: number; status: number; error?: string }> = [];
  type FrontLoopSql = { mode?: string; statements?: number; sites?: number; unlisted?: string[]; unlisted_sites?: Array<{ site: string; statements: number }> };
  // A holder, so the value set inside the run's try block is not narrowed away at its use below.
  const seen: { frontLoopSql: FrontLoopSql | null } = { frontLoopSql: null };
  const errors: string[] = [];
  const requestErrors: string[] = [];
  // The copy runs outside the run's memory cap when the caller restored first (`restore`): copying a multi-GB tree inside a
  // capped scope fills it with dirty pages (the CI runner's 400 MB scope was OOM-killed in cp, 16 Nov 2026).
  const restoreStarted = Date.now();
  const restoredMarker = join(dir, 'restored');
  const restoredOutside = existsSync(restoredMarker);
  if (restoredOutside) rmSync(restoredMarker, { force: true }); else restorePristine(dir);
  const restore_ms = Date.now() - restoreStarted;
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
  const vmstatAtStart = readVmstat();
  const meminfoAtStart = readMeminfo();
  let backgroundTimeline: ReturnType<typeof startBackgroundTimeline>;
  const backgroundTimelinePath = join(metrics, 'background.timeline.jsonl');
  const roles: Array<{ role: string; pid: number }> = [];
  const anonSampler = sampleAnonMemory(() => roles, () => enginesStartedAt ?? Date.now());
  const ioSampler = sampleProcessIo(() => roles, role => readReady(role as Role));
  let cgroupAtEnd: ReturnType<typeof readCgroupMemory> = {};
  let meminfoAtEnd: ReturnType<typeof readMeminfo> = {};
  let walAtOpen: Record<string, number> = {};
  try {
    walAtOpen = walSizes(dir);
    coldFiles(dir);
    for (const role of ROLES) {
      const profile = join(metrics, role);
      timing[role].spawnedAt = nowMs();
      enginesStartedAt ??= timing[role].spawnedAt;
      const child = Bun.spawn([process.execPath, '--preload', preload, join(import.meta.dir, '../src/workers/engine/server.ts')], {
        env: { ...env, OLYMPUS_WORKER_ENGINE_ROLE: role, OLYMPUS_LOOP_STALL_PROFILE: profile, OLYMPUS_MAIN_THREAD_SQL_LOG: `${profile}.sql.jsonl`, OLYMPUS_CPU_SAMPLE_LOG: `${profile}.cpu.jsonl` },
        stdout: 'pipe', stderr: 'pipe',
      });
      children.push(child);
      roles.push({ role, pid: child.pid });
      if (role === 'background') backgroundTimeline = startBackgroundTimeline(child.pid, backgroundTimelinePath);
      void child.exited.then(() => { timing[role].stoppedAt ||= nowMs(); });
      writeFileSync(pidFile, JSON.stringify(children.map(entry => entry.pid)));
      for (const stream of [child.stdout, child.stderr]) pumps.push((async () => {
        const decoder = new TextDecoder();
        let partial = '';
        for await (const chunk of stream as ReadableStream<Uint8Array>) {
          const text = decoder.decode(chunk, { stream: true });
          const lines = (partial + text).split('\n');
          partial = lines.pop() ?? '';
          for (const line of lines) keepEngineLine(role, line);
          output[role] = (output[role]! + text).slice(-100_000);
        }
        if (partial) keepEngineLine(role, partial + decoder.decode());
      })());
    }
    const deadline = Date.now() + seconds * 1000;
    while (!ROLES.every(readReady)) {
      if (Date.now() >= deadline || children.some(child => child.exitCode !== null)) throw new Error('Engine boot failed or timed out; see last-run.json engine_logs');
      await Bun.sleep(100);
    }
    const workerFetch = createWorkerFetch({ platform: 'linux', env });
    const origin = `http://127.0.0.1:${port}`;
    const bearer = { Authorization: `Bearer ${env.OLYMPUS_WORKER_AUTH_TOKEN}` };
    const post = async (path: string, body: object, headers: Record<string, string> = bearer) => {
      const start = performance.now();
      const response = await workerFetch(origin + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(60_000, Math.max(1, deadline - Date.now()))) });
      const json = await response.json() as Record<string, unknown>;
      return { ms: performance.now() - start, status: response.status, json, cookie: response.headers.get('Set-Cookie')?.split(';')[0] };
    };
    const owner = await post('/dashboard/control/session', {}, { ...bearer, Origin: origin });
    if (!owner.cookie || typeof owner.json.csrf_token !== 'string') throw new Error(`Cannot open dashboard controls (HTTP ${owner.status}).`);
    const local = await post(DASHBOARD_LOCAL_CONTROL_SESSION_PATH, {}, { Origin: origin, Cookie: owner.cookie, 'X-Olympus-CSRF': owner.json.csrf_token });
    if (!local.cookie || typeof local.json.csrf_token !== 'string') throw new Error(`Cannot unlock the local Privacy dashboard (HTTP ${local.status}).`);
    const privacyHeaders = { Origin: origin, Cookie: local.cookie, 'X-Olympus-CSRF': local.json.csrf_token };
    let clickSequence = 0;
    const click = async () => {
      const started = performance.now();
      const id = `${options.runCase}-click-${clickSequence + 1}`;
      const sent_at = new Date().toISOString();
      // Seeded Personal rows, away from the read probe's item and the judge's held rows.
      const first = Math.min(13, shape.shape.items - 1);
      const count = Math.ceil((shape.shape.items - first) / 20);
      const itemId = ownerTierItemId(identity(first + (clickSequence++ % count) * 20));
      try {
        const { ms, status, json } = await post('/dashboard/privacy/items/set', { item_id: itemId, tier: 'private' }, { ...privacyHeaders, 'X-Olympus-Click-Id': id });
        const received = status === 202 && json.state === 'pending' && typeof json.request_id === 'string';
        const sample = { id, sent_at, ms, status, received, ...(received ? { request_id: json.request_id as string } : { error: json.error ?? json.message }) };
        clicks.push(sample);
        if (received) pendingClicks.set(json.request_id as string, { started, click: sample });
      } catch (error) {
        clicks.push({ id, sent_at, ms: performance.now() - started, status: 0, received: false, error: String(error) });
      }
    };
    const pollClicks = async () => {
      await Promise.all([...pendingClicks].map(async ([id, entry]) => {
        const result = await post('/dashboard/privacy/items/status', { request_id: id }, privacyHeaders);
        if (result.json.state === 'pending') return;
        entry.click.settled_ms = Math.round(performance.now() - entry.started);
        entry.click.saved = result.status === 200 && result.json.ok === true;
        if (!entry.click.saved) entry.click.error = result.json.error ?? result.json.message;
        pendingClicks.delete(id);
      }));
    };
    writeFileSync(join(dir, 'start'), 'start');
    let pollingClicks = false;
    let nextAsk = Date.now(), nextRead = Date.now(), nextAck = Date.now(), nextDash = Date.now(), askSequence = 0, ackSequence = 0;
    const statusPath = engineStatusSnapshotPath(env);
    while (Date.now() < deadline) {
      if (children.some(child => child.exitCode !== null)) throw new Error('Engine exited during measurement');
      if (Date.now() >= nextAck) {
        // Command acknowledgement on the background socket, timed to the 202, and the status snapshot's age, once a second.
        nextAck += 1000;
        requests.push(click());
        if (pendingClicks.size > 0 && !pollingClicks) {
          pollingClicks = true;
          requests.push(pollClicks()
            .catch(error => { requestErrors.push(`privacy status: ${error.message}`); })
            .finally(() => { pollingClicks = false; }));
        }
        const start = performance.now();
        requests.push(fetch('http://localhost/engine/commands', { unix: env.OLYMPUS_ENGINE_BACKGROUND_SOCKET, method: 'POST', headers: { Authorization: `Bearer ${env.OLYMPUS_WORKER_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: `loopstall-ack-${ackSequence++}`, command: { kind: 'dashboard_samples', samples: [] } }), signal: AbortSignal.timeout(60_000) } as RequestInit)
          .then(async response => { const json = await response.json().catch(() => ({})) as Record<string, unknown>; acks.push({ at: new Date().toISOString(), ms: Math.round(performance.now() - start), status: response.status, ...(typeof json.loop_held_ms === 'number' ? { loop_held_ms: json.loop_held_ms } : {}) }); })
          .catch(error => { acks.push({ at: new Date().toISOString(), ms: Math.round(performance.now() - start), status: 0, error: error.message }); }));
        try { const status = JSON.parse(readFileSync(statusPath, 'utf8')) as { written_at?: string; loop_held_ms?: number }; if (status.written_at) statusAges.push({ age_ms: Date.now() - Date.parse(status.written_at), ...(typeof status.loop_held_ms === 'number' ? { loop_held_ms: status.loop_held_ms } : {}) }); } catch { /* not written yet */ }
      }
      if (Date.now() >= nextDash) {
        // What the dashboard reads (its health poll and the source status), timed end to end on the front, once a second.
        nextDash += 1000;
        for (const path of ['/v1/health', '/v1/source/index/status']) {
          const start = performance.now();
          requests.push(workerFetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${env.OLYMPUS_WORKER_AUTH_TOKEN}` }, signal: AbortSignal.timeout(60_000) })
            .then(async response => { await response.arrayBuffer(); dashReads.push({ path, ms: Math.round(performance.now() - start), status: response.status }); })
            .catch(error => { dashReads.push({ path, ms: Math.round(performance.now() - start), status: 0, error: error.message }); }));
        }
      }
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
    // SQLite on the front's loop (control plane, 5e38045): the front's own count of statements and call sites, and any site not
    // on config/front-loop-sql-allowance.json. Read from health, since the logs keep only their tail.
    try {
      const response = await workerFetch(`http://127.0.0.1:${port}/v1/health`, { headers: { Authorization: `Bearer ${env.OLYMPUS_WORKER_AUTH_TOKEN}` }, signal: AbortSignal.timeout(30_000) });
      seen.frontLoopSql = ((await response.json()) as { front_loop_sql?: FrontLoopSql }).front_loop_sql ?? null;
    } catch (error) { requestErrors.push(`front health: ${error instanceof Error ? error.message : String(error)}`); }
    finished = true;
    await Promise.all(requests);
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  finally {
    // A responsive engine can save its last profiler window before shutdown.
    const sampling = children.flatMap((child, index) => {
      const path = join(metrics, ROLES[index]!);
      if (child.exitCode !== null || !existsSync(`${path}.beats.jsonl`)) return [];
      child.kill('SIGUSR2');
      return [{ child, path }];
    });
    const sampleDeadline = nowMs() + FINAL_SAMPLE_WAIT_MS;
    while (nowMs() < sampleDeadline && sampling.some(({ child, path }) => child.exitCode === null && !existsSync(`${path}.sampled`))) {
      await Bun.sleep(BEAT_MS);
    }
    for (const role of ROLES) if (timing[role].spawnedAt) timing[role].stoppedAt ||= nowMs();
    pressureSampler.stop();
    anonSampler.stop();
    ioSampler.stop();
    cgroupAtEnd = readCgroupMemory();
    meminfoAtEnd = readMeminfo();
    await backgroundTimeline?.stop();
    for (const child of children) child.kill('SIGKILL');
    await Promise.all(children.map(child => child.exited)); await Promise.all(pumps);
    await Promise.allSettled(requests);
    stub.stop(true);
  }
  const readMeasurements = (role: Role) => {
    const path = join(metrics, role);
    const rows = readJsonLines<CpuRow>(`${path}.cpu.jsonl`);
    if (existsSync(`${path}.cpu.jsonl`)) writeFileSync(join(dir, `last-run-${role}.cpu.jsonl`), readFileSync(`${path}.cpu.jsonl`));
    const sampled = `${path}.sampled`;
    if (existsSync(sampled)) {
      const stamp = readFileSync(sampled, 'utf8');
      if (stamp) timing[role].stoppedAt = Number(stamp);
    }
    const beats = readJsonLines<Beat>(`${path}.beats.jsonl`).filter(beat => beat.endMs <= timing[role].stoppedAt);
    // The process could have emitted readiness just before it exited.
    readReady(role);
    return {
      ...summarizeBeats(role, beats, rows.flatMap(row => row.beat_sites), timing[role]),
      freezes: rows.filter(row => row.freezes.count).map(row => ({ role, at: row.at, freezes: row.freezes })),
    };
  };
  const backgroundMeasurement = readMeasurements('background');
  const frontMeasurement = readMeasurements('front');
  const background = backgroundMeasurement.loop;
  const front = frontMeasurement.loop;
  const siteTable = { background: backgroundMeasurement.sites, front: frontMeasurement.sites };
  const cpuFreezes = [...backgroundMeasurement.freezes, ...frontMeasurement.freezes];
  const slow_sql = ['background', 'front'].flatMap(role => {
    const path = join(metrics, `${role}.sql.jsonl`);
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => ({ role, ...JSON.parse(line) })) : [];
  });
  let workloads = { sync_items: 0, embed_chunks: 0, embed_passes_started: 0, judge_passes: 0, recounts: 0, recounts_started: 0, failures: [] as string[] };
  if (existsSync(join(dir, 'workloads.json'))) workloads = JSON.parse(readFileSync(join(dir, 'workloads.json'), 'utf8'));
  const workload_ok = finished && errors.length === 0 && workloads.failures.length === 0 && workloads.sync_items > 0 && workloads.embed_passes_started > 0 && workloads.judge_passes > 0 && workloads.recounts_started > 0
    && modelCalls.judge > 0 && asks.some(ask => ask.status === 200 && typeof ask.evidence_ms === 'number') && forwarded.some(read => read.status === 200);
  // The socket probe still measures the control thread and the status snapshot.
  const ackOk = acks.filter(ack => ack.status === 202 || ack.status === 200);
  const ackSummary = { count: acks.length, ok: ackOk.length, max_ms: Math.max(0, ...acks.map(ack => ack.ms)), over_1s: acks.filter(ack => ack.ms >= LOOP_STALL_LIMIT_MS || !(ack.status === 202 || ack.status === 200)).slice(0, 50),
    max_loop_held_ms: Math.max(0, ...acks.map(ack => ack.loop_held_ms ?? 0)), status_max_age_ms: Math.max(0, ...statusAges.map(row => row.age_ms)), status_reads: statusAges.length,
    status_max_loop_held_ms: Math.max(0, ...statusAges.map(row => row.loop_held_ms ?? 0)),
    no_control_thread: /no control thread here|the control thread ended/.test(output.background ?? '') };
  // Typical case beside the worst (plan, 16 Nov 2026), reported only until two runs show the measurement is steady:
  // click acknowledgement p95 under 100 ms, dashboard reads p95 under 300 ms, both worst under 1 s.
  const dashOk = dashReads.filter(read => read.status === 200);
  const typical = { ack_p95_ms: percentile(clicks.map(click => click.ms), 0.95), dashboard_p95_ms: percentile(dashReads.map(read => read.ms), 0.95), dashboard_max_ms: Math.max(0, ...dashReads.map(read => read.ms)),
    dashboard_reads: dashReads.length, dashboard_failed: dashReads.length - dashOk.length, dashboard_failures: dashReads.filter(read => read.status !== 200).slice(0, 10),
    front_beat_p95_ms: beatP95(front) ?? null, background_beat_p95_ms: beatP95(background) ?? null };
  const clickSummary = { count: clicks.length, max_ms: Math.round(Math.max(0, ...clicks.map(click => click.ms))),
    over_1s: clicks.filter(click => !click.received || click.ms >= LOOP_STALL_LIMIT_MS).slice(0, 50).map(click => ({ ...click, trace: clickTrace.get(click.id) ?? [] })),
    traced: clicks.filter(click => clickTrace.has(click.id)).length,
    settled: clicks.filter(click => click.settled_ms !== undefined).length, pending: pendingClicks.size,
    max_settled_ms: Math.max(0, ...clicks.map(click => click.settled_ms ?? 0)),
    failures: clicks.filter(click => click.saved === false), samples: clicks };
  const ack_ok = clickSummary.count > 0 && clickSummary.over_1s.length === 0;
  const privacy_restart = await privacyClickRestartGate();
  const walAtEnd = walSizes(dir);
  const walLines = sqliteLines.filter(entry => entry.line.includes('sqlite wal:'));
  const checkpoint = sqliteLines.filter(entry => entry.line.includes('sqlite checkpoint:')).slice(0, 2000);
  const checkpoint_timing = checkpoint.flatMap(({ at, role, line }) => {
    const match = /sqlite checkpoint: (\S+) .*?\bms=(\d+)/.exec(line);
    return match ? [{ at, role, store: match[1], ms: Number(match[2]), since_spawn_ms: Math.round(Date.parse(at) - timing[role].spawnedAt) }] : [];
  });
  const guards = sqliteGuards(walAtEnd, sqliteLines, { fromFirstLevel: options.runCase === 'boot-after-upgrade' });
  // Boot after upgrade: how long the padded WAL took to come down to the limit.
  const firstLevel = options.runCase === 'boot-after-upgrade' ? sqliteLines.find(entry => /tier-ledger\S* .*?wal_bytes=(\d+)/.test(entry.line) && Number(/wal_bytes=(\d+)/.exec(entry.line)![1]) <= WAL_END_LIMIT_BYTES) : undefined;
  // From the engines' start (plan, 16 Nov 2026 14:58Z): at or under 64 MB within 5 minutes; longer while making progress is a
  // report to the plan with the reason, not an automatic fail.
  const padded_wal_level_s = firstLevel ? Math.round((Date.parse(firstLevel.at) - (enginesStartedAt ?? started)) / 100) / 10 : null;
  // One bar for the 600k gate and the quick cold test (plan, 16 Nov 2026).
  const control_ok = !ackSummary.no_control_thread && (options.runCase === 'boot-after-upgrade' || ackSummary.status_max_age_ms <= 10_000);
  const pass = gate({ background, front, workload_ok, wal_ok: guards.wal_ok, ack_ok: ack_ok && control_ok, privacy_restart_ok: privacy_restart.pass, runCase: options.runCase });
  // Retired as a bar (owner, 16 Nov 2026); kept in the receipt for comparison with earlier runs.
  const strict_1s = background.beats > 0 && front.beats > 0 && background.max_ms < LOOP_STALL_LIMIT_MS && front.max_ms < LOOP_STALL_LIMIT_MS;
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const receipt = { phase: 'run', case: options.runCase, sha, pass, strict_1s, restore_ms, restored_outside: restoredOutside, padded_wal_level_s, judged: modelCalls.judge, host_busy: false, host, qualified: isCapped, memory_max: memoryMax, elapsed_ms: Date.now() - started, background, front, slow_sql, forwarded, asks, workloads, workload_ok, model_calls: modelCalls, privacy_click: clickSummary, privacy_restart, command_ack: ackSummary, ack_ok, control_ok, typical, front_loop_sql: seen.frontLoopSql, request_errors: requestErrors, errors, cpu_freezes: cpuFreezes.slice(0, 60), pressure: pressureSummary(pressureSampler.samples), anon_memory: anonSampler.peaks,
    sqlite_mmap: options.sqliteMmap ?? 'default', process_io: ioSampler.summary(), meminfo: { start: meminfoAtStart, end: meminfoAtEnd }, cgroup_memory_end: cgroupAtEnd,
    vmstat: Object.fromEntries(Object.entries(readVmstat()).map(([key, value]) => [key, value - (vmstatAtStart[key] ?? value)])),
    background_timeline: summarizeBackgroundTimeline(backgroundTimelinePath, freezeLines, join(metrics, 'background.freezes.log')),
    sqlite: { guards, wal_bytes_at_open: walAtOpen, wal_bytes_at_end: walAtEnd, settings: sqliteLines.filter(entry => entry.line.includes('sqlite settings:')).slice(0, 200),
      checkpoint, checkpoint_timing,
      room: sqliteLines.filter(entry => entry.line.includes('sqlite wal room:') || entry.line.includes('sqlite wal held:')).slice(0, 500), wal: walLines.slice(0, 2000) }, freezes_log: freezeLines.slice(0, 500) };
  writeFileSync(join(dir, 'last-run.json'), JSON.stringify({ ...receipt, engine_logs: output }, null, 2));
  // last-run.json stays on the host and the next run replaces it; an engine that died puts its last words in the job log too.
  if (errors.length) for (const role of ['background', 'front']) console.error(`--- ${role} engine log tail ---\n${output[role]!.slice(-6_000)}`);
  console.log(JSON.stringify(receipt));
  // One line per engine per run (plan, 16 Nov 2026): worst stall and its site, then pass or fail; then a per-site table.
  for (const [role, loop] of [['front', front], ['background', background]] as const) {
    const limit = role === 'front' ? frontLimitMs(options.runCase) : BACKGROUND_PROGRESS_LIMIT_MS;
    const p95 = beatP95(loop);
    console.log(`${options.runCase} ${role}: after-ready p95 beat ${p95 === undefined ? 'n/a' : `<= ${p95} ms`}, worst ${Math.round(loop.max_ms)} ms at ${loop.worst_site}, beats over 1 s: ${loop.over_1s}; ${loop.beats > 0 && loop.max_ms < limit ? 'PASS' : 'FAIL'} (bar ${limit / 1000} s); pre-ready hold ${Math.round(loop.pre_ready_ms)} ms at ${loop.pre_ready_site} (reported)`);
  }
  console.log(`${options.runCase} Make Private receipt: worst ${clickSummary.max_ms} ms over ${clickSummary.count} posts (${clickSummary.over_1s.length} at or over 1 s or failed); ${ack_ok ? 'PASS' : 'FAIL'} (bar 1 s). Settlement (reported): worst ${clickSummary.max_settled_ms} ms across ${clickSummary.settled} settled, ${clickSummary.pending} pending at cutoff.`);
  console.log(`${options.runCase} Make Private, front restart before commit: ${privacy_restart.pass ? 'PASS' : 'FAIL'} (${privacy_restart.ms} ms), ${privacy_restart.outcome}.`);
  console.log(`${options.runCase} socket ack (reported): worst ${ackSummary.max_ms} ms over ${ackSummary.count} posts (${ackSummary.over_1s.length} at or over 1 s or failed), status snapshot oldest ${ackSummary.status_max_age_ms} ms${ackSummary.no_control_thread ? ', NO CONTROL THREAD' : ''}.`);
  console.log(`${options.runCase} anonymous memory (reported): ${Object.entries(anonSampler.peaks).map(([role, entry]) => `${role} peak ${entry.peak_anon_mib} MiB at ${entry.at_s} s, last ${entry.last_anon_mib} MiB`).join('; ') || 'not sampled'}`);
  console.log(`${options.runCase} typical (reported, not gated yet): click ack p95 ${typical.ack_p95_ms} ms (target 100); dashboard reads p95 ${typical.dashboard_p95_ms} ms, worst ${typical.dashboard_max_ms} ms over ${typical.dashboard_reads}${typical.dashboard_failed ? `, ${typical.dashboard_failed} failed` : ''} (target 300, worst 1000); front beat p95 ${typical.front_beat_p95_ms === null ? 'n/a' : `<= ${typical.front_beat_p95_ms} ms`}`);
  // Report only for 1.5 (plan, 16 Nov 2026): the allowance list is incomplete, so an unlisted site is usually one no run had reached.
  // A site matters to the gate only as the named frame of a front beat over 1 s (the per-site table above).
  const frontLoopSql = seen.frontLoopSql;
  const unlistedSites = frontLoopSql?.unlisted_sites ?? frontLoopSql?.unlisted?.map(site => ({ site, statements: NaN })) ?? [];
  console.log(`${options.runCase} front loop SQL (reported, not gated): ${frontLoopSql ? `${frontLoopSql.statements ?? '?'} statements at ${frontLoopSql.sites ?? '?'} sites, ${unlistedSites.length} not on the allowance list${unlistedSites.length ? `:\n${unlistedSites.map(entry => `  ${Number.isNaN(entry.statements) ? '?' : entry.statements} statements  ${entry.site}`).join('\n')}` : ''}` : 'not reported by this build'}`);
  const peaks = Object.entries(guards.wal_peak).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, bytes]) => `${label} ${Math.round(bytes / 1048576)} MB`).join(', ') || 'no wal lines';
  console.log(`${options.runCase} WAL: peak ${peaks}${options.runCase === 'boot-after-upgrade' ? ` (from each file's first rewind; padded ledger at or under 64 MB after ${padded_wal_level_s ?? 'never'} s from the engines' start, bar 300 s, predicted about 60 s${padded_wal_level_s === null || padded_wal_level_s > 300 ? '; OVER 5 MIN: report to the plan with the reason' : ''})` : ''}; over 64 MB (reported): ${guards.wal_peak_over.map(row => `${row.label} ${row.crossings}x, ${row.over_s} s over, longest ${row.longest_s} s`).join('; ') || 'none'}; bar: back under 64 MB within 60 s (${guards.wal_slow_back.length} not), none over 1 GB (${guards.wal_over_1gb.length}), none over at end (${guards.wal_over_limit.length}); ${guards.wal_ok ? 'PASS' : 'FAIL'}`);
  console.log(`${options.runCase} work: ${workload_ok ? 'complete' : 'INCOMPLETE'} (sync ${workloads.sync_items}, embed ${workloads.embed_chunks}, judge passes ${workloads.judge_passes}, judge model calls ${modelCalls.judge}); ${workload_ok ? 'PASS' : 'FAIL'}`);
  console.log(`${options.runCase} release bar (front under ${frontLimitMs(options.runCase) / 1000} s, Make Private receipt under 1 s, background under 30 s, work done, WAL back under 64 MB within 60 s and never over 1 GB): ${pass ? 'PASS' : 'FAIL'}. Retired 1 s-on-both: ${strict_1s ? 'pass' : 'fail'}.`);
  console.log(JSON.stringify({ phase: 'sites', case: options.runCase, ...siteTable }));
  rmSync(runDir, { recursive: true, force: true });
  // A run that judged nothing did not exercise the background's long holds (plan, 16 Nov 2026): it counts as not run, not as a pass.
  if (modelCalls.judge === 0) { console.log(`${options.runCase}: NOT RUN: the judge made no model calls, so the background's judging was never measured.`); return 'not_run' as const; }
  return pass;
}
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const flag = (name: string, fallback?: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1]; };
  const dir = flag('dir');
  const number = (name: string, fallback: string) => { const n = Number(flag(name, fallback)); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid --${name}`); return n; };
  if (dir && command === 'pad-wal') padWal(resolve(dir), number('wal-mb', '2048'));
  if (dir && command === 'restore') { restorePristine(resolve(dir)); writeFileSync(join(resolve(dir), 'restored'), new Date().toISOString()); process.exit(0); }
  if (!dir || !['build', 'run'].includes(command ?? '')) throw new Error('Usage: loop-stall-test.ts build|restore|run --dir PATH [--items N] [--chunks-per-item N] [--seconds N] [--memory-max 2G] [--case steady|boot-after-upgrade] [--wal-mb 2048] [--io-floor-ms 50] [--io-wait-seconds 600] [--sqlite-mmap on|off|bounded]');
  const runCase = flag('case', 'steady') as RunCase;
  const sqliteMmap = flag('sqlite-mmap') as 'on' | 'off' | 'bounded' | undefined;
  if (sqliteMmap !== undefined && !['on', 'off', 'bounded'].includes(sqliteMmap)) throw new Error('Invalid --sqlite-mmap; use on, off or bounded');
  if (!['steady', 'boot-after-upgrade'].includes(runCase)) throw new Error('Invalid --case; use steady or boot-after-upgrade');
  if (command === 'build') await build(resolve(dir), number('items', '600000'), number('chunks-per-item', '1'));
  else {
    const result = await run(resolve(dir), number('seconds', '300'), flag('memory-max', '2G')!, { runCase, walBytes: number('wal-mb', '2048') * 1024 * 1024, ioFloorMs: number('io-floor-ms', '50'), ioWaitSeconds: number('io-wait-seconds', '600'), quick: args.includes('--quick'), ...(sqliteMmap ? { sqliteMmap } : {}) });
    // Exit 3 is "host busy" and 4 "not run" (no judging): neither measured the engine.
    process.exitCode = result === 'host_busy' ? 3 : result === 'not_run' ? 4 : result ? 0 : 1;
  }
  process.exit(process.exitCode ?? 0);
}
