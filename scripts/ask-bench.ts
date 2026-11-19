#!/usr/bin/env bun
/** Synthetic Ask benchmark. Build outside the memory scope, then run both engine roles inside it. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { openConnectorStore, openTierLedger, openTierSniffer, storageAccountForCorpus } from '../src/core/source-storage.ts';
import { buildEnvBridgeSovereigntyConfig } from '../src/core/sovereignty.ts';
import { createWorkerFetch } from '../src/core/worker-transport.ts';
import { tierLedgerPathForStore, tierSnifferPathForLedger } from '../src/workers/classification/tier-ledger-path.ts';
import { classifyItemTiers, type TierDecision } from '../src/workers/classification/tier-classifier.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import { runTierClassifier } from '../src/workers/classification/tier-cli.ts';
import { engineStatusSnapshotPath } from '../src/workers/engine-split/runtime.ts';
import { readEngineStatusSnapshot } from '../src/workers/engine-split/snapshot.ts';
import type { SourceSchedulerStatus } from '../src/workers/source-scheduler.ts';
import type { ConnectorStoreItemCopy } from '../src/workers/connector-store/local-index.ts';
import type { AskBenchSqlRow, AskBenchSqlThread } from '../src/workers/connector-store/ask-bench-sql.ts';
import type { SourceAnswerLatencyLedgerRecord, SourceAnswerLatencyTraceRecord } from '../src/workers/source-index/answer-latency-log.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';
import { BUILT_IN_EMBEDDING_MODEL } from '../src/workers/source-index/built-in-embedding/manifest.ts';
import { OpenAICompatibleSourceEmbeddingProvider, type SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { memoryMaxBytes } from './loop-stall-test.ts';

const VERSION = 1;
const MODEL = 'ask-bench-synthetic';
const EPOCH = 'ask-bench-v1';
const JUDGE_PROFILE = 'ask-bench-judge';
const DIMENSION = BUILT_IN_EMBEDDING_MODEL.dimension;
const DISK_BUDGET = 12_000_000_000;
const common = 'orchard';
const terms = ['sextant', common, 'kiln', 'viaduct', 'cobalt', 'azurite', 'beacon'];
const largeCounts = [4975, 391960, 2474, 1533, 596, 32, 6347];
const secondCounts = [321, 20003, 85, 95, 58, 3, 475];
const populations = [631613, 207965, 178635, 70777, 33509, 17127, 3473, 2119, 698, 175, 91, 72, 64, 64];
const stores = populations.map((population, index) => {
  const sourceId = `ask-bench.store-${String(index + 1).padStart(2, '0')}`;
  const trustDomain = index % 2 === 0 ? 'internal' as const : 'secure_local' as const;
  const family = index < 2 ? 'chat' as const : index % 3 === 2 ? 'email' as const : 'file' as const;
  return { sourceId, corpusId: `${trustDomain}.${sourceId}`, trustDomain, family, population, vector: index < 13 };
});
type Store = typeof stores[number];

const rareTerms = ['azurite', 'garnet', 'basalt', 'jasper', 'topaz', 'onyx'];
// The rare words occur individually in the tail of the distribution. Only the
// planted record uses its rare word immediately before the common concept.
const questions = rareTerms.map((rare, index) => ({
  phrase: `${rare} ${common}`,
  question: `What is sextant "${rare} ${common}" kiln viaduct cobalt beacon?`,
  expected: { corpus_id: stores[index]!.corpusId, provider_item_id: '0' },
}));

// The ranked filler never contains the benchmark's query terms. Each concept is
// placed independently so the FTS search has a head and a long tail.
const vocabulary = 'parcel ridge maple harbor pier linen journal slate copper river gravel freight meadow cedar violet sand lantern canvas kettle cart island bramble thimble spindle shutter plume folio saddle packet hinge anvil reed timber moss oar wheel flint rope wick latch bolt quarry bay timberline'.split(' ');
const zipf = vocabulary.reduce<number[]>((sum, _, index) => [...sum, (sum.at(-1) ?? 0) + 1 / (index + 1)], []);
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const SHARED_WEIGHT = Math.sqrt(0.3 / 0.7);
const SHARED_DIRECTION = (() => {
  const next = random(0x51ed270b);
  const values = Array.from({ length: DIMENSION }, () => next() - 0.5);
  const norm = Math.hypot(...values);
  return values.map(value => value / norm);
})();

function syntheticVector(text: string): number[] {
  // The planted phrase has one reproducible vector across query and document.
  // Filler vectors are dense and vary by item, so the digest heap and rescoring both do work.
  const planted = questions.findIndex(({ phrase }) => text.includes(phrase));
  const seed = planted < 0 ? Bun.hash.crc32(text) : planted + 1;
  const next = random(seed);
  const noise = Array.from({ length: DIMENSION }, () => next() - 0.5);
  const noiseNorm = Math.hypot(...noise);
  // Every vector shares one direction, as real text embeddings do: unrelated
  // texts score about 0.3 against each other, above the lane's score floor.
  // Uncorrelated filler scored about 0, so no item qualified and the lane
  // read every full vector in the store, which real stores do not do.
  const values = noise.map((value, index) => value / noiseNorm + SHARED_DIRECTION[index]! * SHARED_WEIGHT);
  const norm = Math.hypot(...values);
  return values.map(value => value / norm);
}

function storeItem(store: Store, storeIndex: number, item: number): RawItem {
  const next = random(Math.imul(item + 1, 0x9e3779b1) ^ Math.imul(storeIndex + 1, 0x85ebca6b));
  const distribution = storeIndex === 1 ? secondCounts : largeCounts;
  const denominator = populations[storeIndex === 1 ? 1 : 0]!;
  const concepts = terms.flatMap((term, index) => {
    if (next() >= distribution[index]! / denominator) return [];
    return index === 5 ? rareTerms : [term];
  });
  const planted = item === 0 ? questions[storeIndex] : undefined;
  const title = planted ? `Synthetic record ${planted.phrase}` : `Synthetic ${store.family} ${item}`;
  const sourceText = Array.from({ length: store.family === 'chat' ? 18 : store.family === 'email' ? 75 : 140 }, () => {
    const roll = next() * zipf.at(-1)!;
    return vocabulary[zipf.findIndex(edge => roll < edge)]!;
  }).join(' ');
  const text = planted ? `The marker for ${planted.phrase} is marker ${storeIndex + 1}. ${terms.filter(term => term !== 'azurite').join(' ')}. ${sourceText}`
    : `${item} ${concepts.join(' ')}. ${sourceText}`;
  const conversation = store.family === 'chat' ? `room-${item % 8192}` : undefined;
  const date = new Date(Date.UTC(2026, 10, 19) - item * 61_000).toISOString();
  return {
    identity: {
      family: store.family, provider: 'ask-bench', accountScope: store.sourceId, providerItemId: String(item),
      localItemId: `${store.sourceId}:${item}`, sourceVersion: '1',
      ...(conversation ? { providerConversationId: conversation } : {}),
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text },
    metadata: { name: title, authoredAt: date, updatedAt: date, locatorUri: `https://example.invalid/${store.sourceId}/${item}` },
    fetchedAt: date,
  };
}

const storesDir = (dir: string) => join(dir, 'stores');
const storePath = (dir: string, store: Store) => join(storesDir(dir), `${store.sourceId}.sqlite`);
const buildPath = (dir: string) => join(dir, 'build.json');
const registryPath = (dir: string) => join(dir, 'corpora.json');
const db = (handle: unknown) => (handle as { db: Database }).db;

type StoreReceipt = {
  corpus_id: string;
  family: string;
  items: number;
  digest_rows: number;
  store_bytes: number;
  ledger_bytes: number;
  judge_bytes: number;
  build_ms: number;
};

type BuildReceipt = {
  version: number;
  scale: number;
  dimension: number;
  build_ms: number;
  store_bytes: number;
  total_bytes: number;
  stores: StoreReceipt[];
};

const storeReceiptPath = (dir: string, index: number) => join(storesDir(dir), `store-${index}.json`);

async function buildStore(dir: string, scale: number, index: number) {
  const spec = stores[index];
  if (!spec) throw new Error('Invalid synthetic store index.');
  const started = performance.now();
  const env = { HOME: dir, XDG_DATA_HOME: join(dir, 'data'), XDG_STATE_HOME: join(dir, 'state'), XDG_CONFIG_HOME: join(dir, 'config') };
  // Match the engine's provider and epoch. The HTTP endpoint contributes to
  // configHash, but the store's vector authority is provider/model/dimension/epoch.
  const authority = new OpenAICompatibleSourceEmbeddingProvider({
    baseUrl: 'http://127.0.0.1:1/v1', model: MODEL, epochId: EPOCH, dimension: DIMENSION,
  });
  const embedder: SourceEmbeddingProvider = {
    provider: authority.provider, backend: authority.backend, modelId: authority.modelId,
    dimension: authority.dimension, epochId: authority.epochId, configHash: authority.configHash,
    async embed(inputs) { return inputs.map(input => syntheticVector(input.text)); },
  };
  const base = classifyItemTiers({ signals: {}, text: 'Synthetic notes.' });
  const dbPath = storePath(dir, spec);
  if (existsSync(dbPath)) throw new Error(`Synthetic store already exists: ${dbPath}`);
  const account = storageAccountForCorpus(spec);
  const tierPath = tierLedgerPathForStore(dbPath);
  const ledger = openTierLedger(account, { dbPath: tierPath }, env);
  const store = openConnectorStore(account, { ...spec, dbPath, tierLedger: ledger }, env);
  const tier = spec.trustDomain === 'internal' ? 'private' : 'secure';
  const trustTier = spec.trustDomain === 'internal' ? 'S3' : 'S4';
  const sensitivity = buildSourceSensitivity({ trustTier, trustDomain: spec.trustDomain });
  const count = Math.max(1, Math.round(spec.population * scale));
  const first = storeItem(spec, index, 0);
  const connector = (item: RawItem): SourceConnector => ({
    id: spec.sourceId, family: spec.family, async authenticate() {},
    async *listItems() { yield { items: [item], done: true }; },
    async fetchItem() { return item; },
    classificationSignals() { return {}; },
  });
  const pending = index === 1 && count > 1 ? 1 : undefined;
  let digestRows: number;
  try {
    for (const handle of [store, ledger]) db(handle).exec('PRAGMA synchronous=OFF');
    // Make a real sync template once per shape. Every later item goes
    // through the production tier-copy path, including FTS and digest writes.
    await store.syncFromConnector(connector(first), { fetchContent: true, placement: () => sensitivity });
    const template = store.exportItemCopy(first.identity);
    if (!template?.chunks.length) throw new Error(`Missing template for ${spec.corpusId}`);
    if (pending !== undefined) {
      // One ordinary ingestion through the real judge queue is enough to check
      // the stub. The rest of the fixture is caught up so idle sweeps dominate.
      const judge = openTierSniffer(account, { dbPath: tierSnifferPathForLedger(tierPath) }, env);
      try {
        const sniffer = new CachedTierSniffer(judge, {
          kind: 'local', modelId: MODEL, profile: { provider: 'local-openai-compatible' }, snifferMode: 'full',
        });
        const item = storeItem(spec, index, pending);
        await store.syncFromConnector(connector(item), {
          fetchContent: true, placement: () => sensitivity, tierClassification: { sniffer },
          reconcileAbsenceAuthority: 'partial_window',
        });
        if (!judge.questionFor(item.identity, 'content')) throw new Error('Synthetic ingestion did not queue a privacy judgment.');
      } finally { judge.close(); }
    }
    const decision: TierDecision = {
      ...base, metadataTier: tier, contentTier: tier, decidedBy: 'sniffer',
      state: 'current', contentRead: true, metadataPending: false, contentPending: false,
    };
    for (let start = 0; start < count; start += 2000) {
      const end = Math.min(count, start + 2000);
      db(ledger).transaction(() => db(store).transaction(() => {
        for (let id = start; id < end; id++) {
          const item = storeItem(spec, index, id);
          if (item.content.kind !== 'text') throw new Error('Expected synthetic text');
          const boundedText = item.content.text;
          const contentHash = createHash('sha256').update(boundedText).digest('hex');
          const chunk = { chunkIndex: 0, boundedText, contentHash, embeddingInputHash: contentHash };
          const copy: ConnectorStoreItemCopy = {
            ...template, identity: item.identity,
            columns: {
              ...template.columns, provider_item_id: item.identity.providerItemId, local_item_id: item.identity.localItemId,
              provider_conversation_id: item.identity.providerConversationId ?? null, title: String(item.metadata.name),
              locator_uri: String(item.metadata.locatorUri), search_text: boundedText,
              authored_at: String(item.metadata.authoredAt), updated_at: String(item.metadata.updatedAt),
              sender_id: spec.family === 'file' ? null : `sender-${id % 4096}`,
              sender_label: spec.family === 'file' ? null : `Synthetic sender ${id % 4096}`,
            },
            chunks: [chunk],
            vectorAuthorities: spec.vector ? [embedder] : [],
            vectors: spec.vector ? [{
              chunkIndex: 0, modelId: MODEL, contentHash,
              embedding: new Uint8Array(new Float32Array(syntheticVector(boundedText)).buffer),
            }] : [],
          };
          const imported = store.importItemCopy(copy, {
            trustTier, syncConnectorId: spec.sourceId, sourceTextCurrent: true,
            ...(spec.vector ? { vectorProvider: embedder } : {}),
          });
          if (imported.vectorsCopied !== Number(spec.vector)) throw new Error(`Vector write failed for ${spec.corpusId}/${id}`);
          // Keep an occasional old content copy behind the real visibility gate.
          if (id !== pending) {
            const hidden = id % 100 === 99;
            ledger.recordRoutedPlacement(item.identity, hidden ? { ...decision, contentTier: 'secure' } : decision, {
              copies: [{ corpusId: spec.corpusId, trustDomain: spec.trustDomain, layers: hidden ? 'metadata' : 'both' }],
              embedHold: hidden,
            });
          }
        }
      })())();
      if (end % 100_000 === 0) console.log(`Seeded ${spec.corpusId} ${end}/${count}`);
    }
    const digests = db(store).query('SELECT count(*) AS n FROM chunk_vector_digest').get() as { n: number };
    digestRows = digests.n;
    if (digestRows !== (spec.vector ? count : 0)) throw new Error(`Incorrect digest row count for ${spec.corpusId}`);
    for (const handle of [store, ledger]) db(handle).query('PRAGMA wal_checkpoint(TRUNCATE)').all();
  } finally {
    store.close();
    ledger.close();
  }
  const storeBytes = statSync(dbPath).size;
  const ledgerBytes = statSync(tierPath).size;
  const judgeBytes = existsSync(tierSnifferPathForLedger(tierPath)) ? statSync(tierSnifferPathForLedger(tierPath)).size : 0;
  const row: StoreReceipt = {
    corpus_id: spec.corpusId, family: spec.family, items: count, digest_rows: digestRows,
    store_bytes: storeBytes, ledger_bytes: ledgerBytes, judge_bytes: judgeBytes, build_ms: Math.round(performance.now() - started),
  };
  writeFileSync(storeReceiptPath(dir, index), JSON.stringify(row));
  console.log(`Built ${JSON.stringify(row)}`);
}

async function build(dir: string, scale: number) {
  if (existsSync(storesDir(dir))) throw new Error('Choose a fresh --dir for build; run can reuse a completed fixture.');
  mkdirSync(storesDir(dir));
  const started = performance.now();
  const receipt: BuildReceipt = { version: VERSION, scale, dimension: DIMENSION, build_ms: 0, store_bytes: 0, total_bytes: 0, stores: [] };
  let nextStore = 0;
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  const seed = async () => {
    while (nextStore < stores.length) {
      const index = nextStore++;
      const child = Bun.spawn([process.execPath, import.meta.path, 'build-store', '--dir', dir, '--scale', String(scale), '--store-index', String(index)],
        { env: { PATH: process.env.PATH, HOME: dir }, stdout: 'inherit', stderr: 'inherit' });
      children.add(child);
      const code = await child.exited;
      children.delete(child);
      if (code !== 0) throw new Error(`Synthetic store ${index + 1} build exited ${code}.`);
      const row = JSON.parse(readFileSync(storeReceiptPath(dir, index), 'utf8')) as StoreReceipt;
      receipt.stores[index] = row;
      receipt.store_bytes += row.store_bytes;
      receipt.total_bytes += row.store_bytes + row.ledger_bytes + row.judge_bytes;
      if (receipt.total_bytes > DISK_BUDGET) throw new Error('Fixture exceeds the 12 GB disk budget; rebuild in a fresh directory at a smaller scale.');
    }
  };
  try {
    // Three independent databases can seed concurrently on the four-core runner.
    await Promise.all([seed(), seed(), seed()]);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    await Promise.all([...children].map(child => child.exited));
  }
  receipt.build_ms = Math.round(performance.now() - started);
  writeFileSync(registryPath(dir), JSON.stringify({
    schemaVersion: 1,
    corpora: stores.map(({ corpusId, sourceId, family, trustDomain, vector }) => ({
      corpusId, sourceId, family, trustDomain, provider: 'ask-bench',
      activationMode: vector ? 'hybrid_primary' : 'lexical_only',
      capabilities: ['answer', 'search', 'status'],
    })),
  }));
  writeFileSync(buildPath(dir), JSON.stringify(receipt, null, 2));
  console.log(`Built scale=${scale} dimension=${DIMENSION} build_ms=${receipt.build_ms} store_bytes=${receipt.store_bytes} total_bytes=${receipt.total_bytes}`);
}

function optionalText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

function cgroupPath(pid: number): string | undefined {
  const relative = /^0::(\/.*)$/m.exec(optionalText(`/proc/${pid}/cgroup`) ?? '')?.[1];
  return relative ? join('/sys/fs/cgroup', relative) : undefined;
}

function scopeBytes(scope: string | undefined, name: string): number | null {
  const raw = scope && optionalText(join(scope, name))?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}

function procNumber(text: string | undefined, key: string): number | null {
  const value = new RegExp(`^${key}:[ \\t]+(\\d+)`, 'm').exec(text ?? '')?.[1];
  return value === undefined ? null : Number(value);
}

function majorFaults(proc: string): number | null {
  const stat = optionalText(`${proc}/stat`);
  if (!stat) return null;
  // comm is parenthesized and can contain spaces. The first suffix field is state (3), majflt is field 12.
  const value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[9];
  return value === undefined ? null : Number(value);
}

function dropFixtureCache(dir: string) {
  // Linux has no scoped vm.drop_caches. Advise eviction only for these fixture
  // files; mapped, dirty, in-use, and SQLite connection-local pages can survive.
  const paths = stores.flatMap(spec => {
    const path = storePath(dir, spec);
    return [path, tierLedgerPathForStore(path)].flatMap(file => [file, file + '-wal']).filter(existsSync);
  });
  const python = Bun.which('python3');
  if (!python) return { status: 'skipped' as const, files: paths.length, detail: 'python3 unavailable' };
  const command = Bun.spawnSync([python, '-c', `import os, sys
for path in sys.argv[1:]:
    with open(path, "rb") as file:
        os.posix_fadvise(file.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
`, ...paths], { stderr: 'pipe' });
  return command.exitCode === 0
    ? { status: 'advised' as const, files: paths.length, detail: 'POSIX_FADV_DONTNEED on fixture databases and WALs (advisory, including in the scope)' }
    : { status: 'skipped' as const, files: paths.length, detail: command.stderr.toString().trim() || `cache advice exited ${command.exitCode}` };
}

function fixtureStub() {
  const calls = { embedding: 0, planner: 0, analyst: 0, judge: 0 };
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/models') return Response.json({ data: [{ id: MODEL }] });
      if (path === '/v1/embeddings') {
        calls.embedding++;
        const { input } = await request.json() as { input: string | string[] };
        const texts = Array.isArray(input) ? input : [input];
        return Response.json({ data: texts.map((text, index) => ({ index, embedding: syntheticVector(text) })) });
      }
      if (path !== '/v1/chat/completions') return new Response('Unknown stub path', { status: 404 });
      const { messages } = await request.json() as { messages: Array<{ role: string; content: string }> };
      const system = messages.find(message => message.role === 'system')?.content ?? '';
      const prompt = messages.find(message => message.role === 'user')?.content ?? '';
      let content: string;
      if (system.includes('Generate up to 3 short, diverse search queries')) {
        calls.planner++;
        content = '[]';
      } else if (/privacy classifier|privacy judge/i.test(system)) {
        calls.judge++;
        content = JSON.stringify({ verdicts: [{ i: 1, tier: 'private', confidence: 1, category: 'ordinary', ownRecord: false, privateKind: 'none' }] });
      } else {
        calls.analyst++;
        // Cite only the planted record for this question, and only if its
        // numbered evidence block actually reaches the model.
        const planted = questions.find(({ question }) => prompt.includes(question));
        const match = planted && new RegExp(`^\\[(\\d+)\\] Synthetic record ${planted.phrase}\\b`, 'm').exec(prompt);
        const answer = match ? `The marker is marker ${questions.indexOf(planted!) + 1}.` : 'The evidence does not contain the marker.';
        content = JSON.stringify({ answer, citations: match ? [{ evidence: Number(match[1]), claim: answer }] : [], unanswered: [], sufficient: Boolean(match) });
      }
      return Response.json({ model: MODEL, choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  return { server, calls };
}

type Args = { dir: string; scale: number; secondsIdle: number; memoryMax?: string; swapMax?: string; extraEnv: Record<string, string>; mode?: string; storeIndex?: number };
const roles = ['background', 'front'] as const;
const MINUTE_MS = 60_000;
const BOOT_TIMEOUT_MS = 10 * MINUTE_MS;
const ASK_TIMEOUT_MS = 5 * MINUTE_MS;

function parseArgs(args: string[]): Args {
  const flags = new Map<string, string>();
  const allowed = ['dir', 'scale', 'seconds-idle', 'memory-max', 'memory-swap-max', 'extra-env', 'scope', 'store-index'];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    const value = args[i + 1];
    if (!args[i]?.startsWith('--') || !key || !allowed.includes(key) || value === undefined || flags.has(key)) {
      throw new Error(`Invalid or duplicate option: ${args[i]}`);
    }
    flags.set(key, value);
  }
  const dir = resolve(flags.get('dir') ?? '');
  if (!dir.startsWith('/tmp/')) throw new Error('Use a synthetic --dir under /tmp.');
  mkdirSync(dir, { recursive: true });
  if (realpathSync(dir) !== dir) throw new Error('Use a synthetic --dir without symlinks.');
  const scale = Number(flags.get('scale') ?? 1);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error('--scale must be greater than 0 and at most 1.');
  const secondsIdle = Number(flags.get('seconds-idle') ?? 300);
  if (!Number.isSafeInteger(secondsIdle) || secondsIdle < 0) throw new Error('--seconds-idle must be a nonnegative integer.');
  const pairs = (flags.get('extra-env') ?? '').trim().split(/\s+/).filter(Boolean).map(pair => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(pair);
    if (!match) throw new Error('--extra-env expects space-delimited KEY=VALUE pairs.');
    return [match[1]!, match[2]!] as const;
  });
  const memoryMax = flags.get('memory-max');
  const swapMax = flags.get('memory-swap-max');
  const mode = flags.get('scope');
  if (mode !== undefined && !['user', 'system', 'inside'].includes(mode)) throw new Error('Use --scope user or system.');
  const storeIndex = flags.get('store-index');
  return { dir, scale, secondsIdle, extraEnv: Object.fromEntries(pairs), ...(memoryMax ? { memoryMax } : {}),
    ...(swapMax ? { swapMax } : {}), ...(mode ? { mode } : {}), ...(storeIndex === undefined ? {} : { storeIndex: Number(storeIndex) }) };
}

type Limits = { memory_max: number; memory_swap_max: number };
function limitsFor(build: BuildReceipt, args: Args): Limits {
  const memory_max = args.memoryMax ? memoryMaxBytes(args.memoryMax) : Math.floor(build.store_bytes / 2);
  const memory_swap_max = args.swapMax === '0' ? 0 : args.swapMax ? memoryMaxBytes(args.swapMax) : Math.floor(memory_max / 4);
  return { memory_max, memory_swap_max };
}

function threadReads(pid: number) {
  const tasks = `/proc/${pid}/task`;
  if (!existsSync(tasks)) return [];
  return readdirSync(tasks).map((tid) => {
    const task = `${tasks}/${tid}`;
    const io = optionalText(`${task}/io`);
    return { tid, comm: optionalText(`${task}/comm`)?.trim() ?? '', read_bytes: procNumber(io, 'read_bytes') ?? 0,
      majflt: majorFaults(task) ?? 0, rchar: procNumber(io, 'rchar') ?? 0 };
  }).sort((left, right) => right.read_bytes - left.read_bytes);
}

function diskSample(pid: number) {
  const readBytes = procNumber(optionalText(`/proc/${pid}/io`), 'read_bytes');
  return { at: Date.now(), readBytes, threads: threadReads(pid) };
}

type DiskSample = ReturnType<typeof diskSample>;
type SiteTotals = Omit<AskBenchSqlRow, 'at'>;

function sqlAttribution(dir: string, pid: number, storeIds: Map<string, string>) {
  const offsets = new Map<string, number>();
  const workers = new Map<string, string>();
  const storeId = (path: string) => storeIds.get(path) ?? (basename(path) || '(unknown)');

  // Keep the cursor at the first row beyond the cutoff for the next window.
  // Stream the new records so a long measuring run can stay inside its cap.
  async function collect(file: string, from: number, to: number, sites: Map<string, SiteTotals>): Promise<void> {
    let offset = offsets.get(file) ?? 0;
    const source = Bun.file(join(dir, file));
    if (offset >= source.size) return;
    const decoder = new TextDecoder();
    let partial = '';
    for await (const chunk of source.slice(offset, source.size).stream()) {
      const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n');
      partial = lines.pop()!;
      for (const line of lines) {
        const row = JSON.parse(line) as AskBenchSqlRow | AskBenchSqlThread;
        if ('at' in row && row.at >= to) return;
        offset += Buffer.byteLength(line) + 1;
        offsets.set(file, offset);
        if (!('at' in row)) {
          if (row.db_path) workers.set(row.tid, row.db_path);
          continue;
        }
        if (row.at < from) continue;
        const { db_path, site, count, ms, read_bytes, majflt } = row;
        const key = JSON.stringify([db_path, site]);
        const total = sites.get(key) ?? { db_path, site, count: 0, ms: 0, read_bytes: 0, majflt: 0 };
        total.count += count;
        total.ms += ms;
        total.read_bytes += read_bytes;
        total.majflt += majflt;
        sites.set(key, total);
      }
    }
  }

  return async (role: typeof roles[number], phase: string, before: DiskSample, after: DiskSample, sites: Map<string, SiteTotals>) => {
    for (const file of readdirSync(dir).filter(name => name.startsWith(`${pid}.`) && name.endsWith('.sql.jsonl'))) {
      await collect(file, before.at, after.at, sites);
    }
    const ranked = [...sites.values()].sort((a, b) => b.read_bytes - a.read_bytes || b.majflt - a.majflt || b.ms - a.ms);
    const top = ranked.slice(0, 15).map(row => ({ ...row, store: storeId(row.db_path) }));
    const attributed = ranked.reduce((sum, row) => sum + row.read_bytes, 0);
    const topBytes = top.reduce((sum, row) => sum + row.read_bytes, 0);
    const processBytes = before.readBytes === null || after.readBytes === null ? null : after.readBytes - before.readBytes;
    const coverage = processBytes !== null && processBytes > 0 ? attributed / processBytes : null;
    const share = (bytes: number) => processBytes !== null && processBytes > 0 ? `${(100 * bytes / processBytes).toFixed(1)}%` : 'n/a';
    const lines = [
      `Idle sites ${role} ${phase} process_read_bytes=${processBytes ?? 'n/a'} top_read_bytes=${topBytes} top_share=${share(topBytes)} attributed_read_bytes=${attributed} attributed_share=${share(attributed)}`,
      'store\tcount\tms\tread_bytes\tmajflt\tsite',
      ...top.map(row => [row.store, row.count, row.ms.toFixed(2), row.read_bytes, row.majflt, row.site].join('\t')),
    ];
    let threads;
    if (coverage !== null && coverage < 0.7) {
      const start = new Map(before.threads.map(thread => [thread.tid, thread]));
      threads = after.threads.map(thread => {
        const base = start.get(thread.tid);
        const dbPath = workers.get(thread.tid);
        return { ...thread, read_bytes: thread.read_bytes - (base?.read_bytes ?? 0), majflt: thread.majflt - (base?.majflt ?? 0),
          rchar: thread.rchar - (base?.rchar ?? 0), ...(dbPath ? { store: storeId(dbPath), db_path: dbPath } : {}) };
      }).sort((a, b) => b.read_bytes - a.read_bytes);
      lines.push(`Idle sites ${role} ${phase} attributed under 70% of process read_bytes`);
      lines.push(`Idle threads ${role} ${phase} ${JSON.stringify(threads)}`);
    }
    return { role, phase, process_read_bytes: processBytes, attributed_read_bytes: attributed, attributed_share: coverage,
      top_read_bytes: topBytes, top_share: processBytes ? topBytes / processBytes : null, top, threads, lines };
  };
}

function idleSample(pid: number, scope: string | undefined, readyAt: number) {
  const status = optionalText(`/proc/${pid}/status`);
  const io = optionalText(`/proc/${pid}/io`);
  return {
    at_s: Math.round((Date.now() - readyAt) / 1000),
    RssFile_kib: procNumber(status, 'RssFile'), RssAnon_kib: procNumber(status, 'RssAnon'),
    rchar: procNumber(io, 'rchar'), read_bytes: procNumber(io, 'read_bytes'),
    'memory.current': scopeBytes(scope, 'memory.current'), 'memory.swap.current': scopeBytes(scope, 'memory.swap.current'),
  };
}

function askTimings(rows: SourceAnswerLatencyLedgerRecord[], answer: SourceIndexAnswerResult) {
  const trace = rows.find((row): row is SourceAnswerLatencyTraceRecord => row.kind === 'source_answer_latency_trace');
  if (!trace || trace.outcome !== 'success') throw new Error('Ask completed without a successful latency trace.');
  const attempts = trace.retrieval_attempts;
  const queries = attempts.flatMap(attempt => attempt.queries);
  const timings = queries.flatMap(query => query.stages ? [query.stages] : []);
  // Planner formulations can run concurrently. Max reports the slowest
  // routed query; full per-attempt and per-query details remain in the trace.
  return {
    evidence_ms: answer.audit.phase_timings?.evidence_pack_ms ?? null,
    lanes_ms: timings.length ? Math.max(...timings.map(stage => stage.lanes_ms)) : null,
    prepare_ms: timings.length ? Math.max(...timings.map(stage => stage.prepare_ms)) : null,
    rerank_ms: trace.rerank?.elapsed_ms ?? null,
    hydration_ms: attempts.reduce((sum, attempt) => sum + attempt.hydration_ms, 0),
    total_ms: answer.audit.phase_timings?.total_ms ?? trace.latency_ms,
    trace,
  };
}

type Ask = ReturnType<typeof askTimings> & {
  label: string;
  ready: 'before' | 'after';
  expected: typeof questions[number]['expected'];
  expected_item_cited: boolean;
  front_majflt: number | null;
  scope_swap_used_bytes: number | null;
  http_ms: number;
  searched_corpora: string[];
};

function askLines(ask: Ask): string[] {
  const { label, ready, evidence_ms, lanes_ms, prepare_ms, rerank_ms, hydration_ms, total_ms,
    expected_item_cited, front_majflt, scope_swap_used_bytes, trace } = ask;
  const shown = (value: number | null) => value ?? 'n/a';
  return [
    `${label} ${ready}-ready evidence_ms=${shown(evidence_ms)} lanes_ms=${shown(lanes_ms)} prepare_ms=${shown(prepare_ms)} rerank_ms=${shown(rerank_ms)} hydration_ms=${hydration_ms} total_ms=${total_ms} expected_item_cited=${expected_item_cited ? 'yes' : 'no'} front_majflt=${shown(front_majflt)} scope_swap_used_bytes=${shown(scope_swap_used_bytes)}`,
    ...trace.retrieval_attempts.flatMap(attempt => attempt.queries.flatMap(query => query.corpus_timings.map(store => {
      const { corpus_id, outcome, adapter_stages, pool } = store;
      const fields = {
        adapter_stages: adapter_stages ?? null, vector_work: pool?.vector_work ?? null,
        keyword_concept_counts: pool?.keyword_concept_counts ?? null, slowest_sql: pool?.slowest_sql ?? [],
      };
      return `  ${attempt.kind}/${query.ordinal} ${corpus_id} ${outcome} ${JSON.stringify(fields)}`;
    }))),
  ];
}

function reproduction(asks: Ask[]) {
  const largest = new Set(stores.slice(0, 2).map(store => store.corpusId));
  const expectedSql = new Set(['concept_weight_count', 'ranked_match_page_bounded', 'vector_digest_page', 'recentItemsRead']);
  const observations = asks.filter(ask => ask.ready === 'after' && ask.label !== 'q1-repeat').map(ask => {
    const lanes = ask.trace.retrieval_attempts.flatMap(attempt => attempt.queries.flatMap(query => query.corpus_timings));
    const big = lanes.filter(lane => largest.has(lane.corpus_id));
    const max = (values: number[]) => Math.max(0, ...values);
    const keyword_lane_ms = max(big.map(lane => lane.adapter_stages?.keyword_lane_ms ?? 0));
    const vector_lane_ms = max(big.map(lane => lane.adapter_stages?.vector_lane_ms ?? 0));
    const big_adapter_ms = max(big.map(lane => lane.adapter_stages?.adapter_elapsed_ms ?? lane.elapsed_ms));
    const slowSql = big.flatMap(lane => lane.pool?.slowest_sql ?? [])
      .filter(statement => statement.label && statement.sql_cpu_ms !== undefined)
      .sort((left, right) => right.sql_ms - left.sql_ms);
    const ioLike = slowSql.find(statement => expectedSql.has(statement.label!) &&
      statement.sql_ms >= 1000 && statement.sql_ms >= 4 * statement.sql_cpu_ms!);
    return {
      label: ask.label, evidence_ms: ask.evidence_ms, lanes_ms: ask.lanes_ms, big_adapter_ms,
      keyword_lane_ms, vector_lane_ms, sql: ioLike ?? slowSql[0] ?? null,
      matches: (ask.evidence_ms ?? 0) > 10_000 && (ask.lanes_ms ?? 0) >= ask.evidence_ms! / 2
        && big_adapter_ms >= (ask.lanes_ms ?? Infinity) / 2 && keyword_lane_ms >= 1000 && vector_lane_ms >= 1000 && Boolean(ioLike),
    };
  });
  return { verdict: observations.some(row => row.matches) ? 'REPRODUCED' : 'NOT REPRODUCED', observations };
}

async function run(args: Args, build: BuildReceipt, limits: Limits) {
  const { dir } = args;
  const scope = cgroupPath(process.pid);
  const actual = { memory_max: scopeBytes(scope, 'memory.max'), memory_swap_max: scopeBytes(scope, 'memory.swap.max') };
  const matchesLimit = (actual: number | null, expected: number) => actual !== null && actual <= expected && expected - actual < 4096;
  if (!scope?.endsWith('.scope') || !matchesLimit(actual.memory_max, limits.memory_max) || !matchesLimit(actual.memory_swap_max, limits.memory_swap_max)) {
    throw new Error(`Expected the benchmark's systemd memory scope. Read ${JSON.stringify({ scope, actual, limits })}.`);
  }
  for (const store of stores) {
    for (const path of [storePath(dir, store), tierLedgerPathForStore(storePath(dir, store))]) {
      if (realpathSync(path) !== path) throw new Error(`Expected a fixture file without symlinks: ${path}`);
    }
  }
  const temp = mkdtempSync('/tmp/oab-'); // Keep the Unix socket path short.
  const { server: stub, calls } = fixtureStub();
  const portProbe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = portProbe.port;
  portProbe.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const baseUrl = `http://127.0.0.1:${stub.port}/v1`;
  const tracePath = join(temp, 'latency.jsonl');
  const token = 'synthetic-ask-bench-token';
  const env: Record<string, string> = {
    // Preserve a full trace when a cold store takes as long as the measured host.
    OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS: '90000',
    ...args.extraEnv,
    PATH: process.env.PATH ?? '', HOME: temp, XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state'),
    XDG_CONFIG_HOME: join(temp, 'config'), XDG_RUNTIME_DIR: temp, NODE_ENV: 'test',
    OLYMPUS_CONFIG: join(temp, 'engine.json'),
    OLYMPUS_SOVEREIGNTY_CONFIG: join(temp, 'sovereignty.json'),
    OLYMPUS_ASK_BENCH: '1',
    OLYMPUS_ASK_BENCH_SQL_DIR: temp,
    OLYMPUS_LOOP_STALL_DIR: '',
    OLYMPUS_EMAIL_SOURCE_HOST: '127.0.0.1', OLYMPUS_EMAIL_SOURCE_PORT: String(port),
    OLYMPUS_WORKER_AUTH_TOKEN: token, OLYMPUS_ENGINE_BACKGROUND_SOCKET: join(temp, 'worker.sock'),
    OLYMPUS_WORKER_SCHEDULER_ENABLED: 'true', OLYMPUS_TIER_SNIFFER_ENABLED: 'true',
    OLYMPUS_UPDATE_CHECK: 'off', OLYMPUS_BUILT_IN_ANALYST: 'false',
    OLYMPUS_SOURCE_INDEX_ENABLED: 'true', OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED: 'true',
    OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES: '32000', OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'false',
    OLYMPUS_ARGUS_SOURCE_ANSWER_BASE_URL: baseUrl, OLYMPUS_ARGUS_SOURCE_ANSWER_MODEL: MODEL,
    OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'local-openai-compatible',
    OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL: baseUrl, OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL: MODEL,
    OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY: String(DIMENSION), OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH: EPOCH,
    OLYMPUS_SOURCE_RERANKER: args.extraEnv.OLYMPUS_SOURCE_RERANKER ?? 'off',
    OLYMPUS_SOURCE_ANSWER_LATENCY_LOG_PATH: tracePath,
    OLYMPUS_SOURCE_INDEX_CORPUS_REGISTRY_PATH: registryPath(dir),
    OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: JSON.stringify(stores.map(store =>
      ({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain, dbPath: storePath(dir, store) }))),
  };
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const stopChildren = () => { for (const child of children) child.kill('SIGKILL'); };
  process.on('exit', stopChildren);
  const ready: Partial<Record<typeof roles[number], { at: string; line: string }>> = {};
  const tails = { front: '', background: '' };
  const pumps: Promise<void>[] = [];
  const idle: ReturnType<typeof idleSample>[] = [];
  const diskReports: Awaited<ReturnType<ReturnType<typeof sqlAttribution>>>[] = [];
  const asks: Ask[] = [];
  const cache = { before_boot: dropFixtureCache(dir), after_q3: null as ReturnType<typeof dropFixtureCache> | null };
  const checkEngines = () => {
    const stopped = children.find(child => child.exitCode !== null || child.signalCode !== null);
    if (stopped) throw new Error(`Engine PID ${stopped.pid} exited (${stopped.exitCode ?? stopped.signalCode}).`);
  };
  const started = Date.now();
  let error: string | undefined;
  let lastTraceSize = 0;
  let frontThreads: number | null = null;
  let listening = false;
  let scheduler: SourceSchedulerStatus | undefined;
  let idleLog: string[] | undefined;
  try {
    const policy = buildEnvBridgeSovereigntyConfig(env);
    // The fixture alone approves this loopback judge through the normal
    // classifier approval path. Both engine roles read that same receipt.
    policy.modelProfiles[JUDGE_PROFILE] = {
      provider: 'local-openai-compatible', trust: 'local', purpose: 'classification',
      baseUrl, model: MODEL, snifferMode: 'full',
    };
    writeFileSync(env.OLYMPUS_SOVEREIGNTY_CONFIG!, JSON.stringify(policy));
    await runTierClassifier(['approve', '--why', 'Synthetic Ask benchmark loopback judge'], { env });
    for (const role of roles) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/workers/engine/server.ts')], {
        env: { ...env, OLYMPUS_WORKER_ENGINE_ROLE: role }, stdout: 'pipe', stderr: 'pipe',
      });
      children.push(child);
      for (const stream of [child.stdout, child.stderr]) {
        pumps.push((async () => {
          const decoder = new TextDecoder();
          let partial = '';
          const acceptLine = (line: string) => {
            tails[role] = (tails[role] + line + '\n').slice(-16_000);
            if (role === 'background' && idleLog) idleLog.push(line);
            if (line.startsWith('[ask-bench] SQL disk sampling stopped')) console.error(`${role}: ${line}`);
            if (line.includes("a store's hidden-copy set could not be built yet")) error = line;
            if (line.includes(`${role}: built ${stores.length} stores' hidden-copy sets`)) {
              ready[role] = { at: new Date().toISOString(), line };
              console.log(line);
            }
            if (role === 'front' && line.includes('source worker listening')) listening = true;
          };
          for await (const chunk of stream) {
            const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n');
            partial = lines.pop() ?? '';
            for (const line of lines) acceptLine(line);
          }
          partial += decoder.decode();
          if (partial) acceptLine(partial);
        })());
      }
    }
    const [background, front] = children as [typeof children[number], typeof children[number]];
    if (children.some(child => cgroupPath(child.pid) !== scope)) throw new Error('An engine did not inherit the memory scope.');
    while (!ready.front || !ready.background || !listening) {
      checkEngines();
      if (error) throw new Error(error);
      if (Date.now() - started >= BOOT_TIMEOUT_MS) throw new Error('Timed out waiting for both hidden-copy sets.');
      await Bun.sleep(100);
    }
    const storeIds = new Map(stores.flatMap(store => {
      const path = storePath(dir, store);
      return [[path, store.corpusId], [tierLedgerPathForStore(path), `${store.corpusId} (tier ledger)`]] as const;
    }));
    const reporters = children.map(child => sqlAttribution(temp, child.pid, storeIds));
    const takeDiskSamples = () => children.map(child => diskSample(child.pid));
    const newSiteTotals = () => roles.map(() => new Map<string, SiteTotals>());
    const reportDisk = async (phase: string, start: DiskSample[], end: DiskSample[], sites: Map<string, SiteTotals>[]) => {
      for (const [index, role] of roles.entries()) {
        const report = await reporters[index]!(role, phase, start[index]!, end[index]!, sites[index]!);
        diskReports.push(report);
        console.log(report.lines.join('\n'));
      }
    };
    const readyAt = Date.now();
    const idleStart = takeDiskSamples();
    const idleSites = newSiteTotals();
    idleLog = [];
    console.log(`READY after ${readyAt - started} ms, idle ${args.secondsIdle} s, scope=systemd`);
    const idleMs = args.secondsIdle * 1000;
    for (let offset = 0; ; offset = Math.min(offset + MINUTE_MS, idleMs)) {
      await Bun.sleep(Math.max(0, readyAt + offset - Date.now()));
      checkEngines();
      const sample = idleSample(background.pid, scope, readyAt);
      idle.push(sample);
      console.log(`Idle ${JSON.stringify(sample)}`);
      if (offset > 0 || offset === idleMs) await reportDisk(`idle +${offset / 1000}s`, idleStart, takeDiskSamples(), idleSites);
      if (offset === idleMs) break;
    }
    // Keep each distinct background log shape, with its count.
    const shapes = new Map<string, { n: number; last: string }>();
    for (const line of idleLog) {
      const shape = line.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '').replace(/[\d.]+/g, '#').slice(0, 120);
      shapes.set(shape, { n: (shapes.get(shape)?.n ?? 0) + 1, last: line });
    }
    idleLog = undefined;
    for (const { n, last } of [...shapes.values()].sort((left, right) => right.n - left.n).slice(0, 60)) console.log(`Idle log x${n} ${last.slice(0, 600)}`);
    const workerFetch = createWorkerFetch({ platform: 'linux', env });
    const askStart = takeDiskSamples();
    try {
      for (const [label, index] of [['q1-new', 0], ['q1-repeat', 0], ['q2-new', 1], ['q3-new', 2], ['q4-new', 3], ['q5-new', 4]] as const) {
        checkEngines();
        if (index === 3) {
          cache.after_q3 = dropFixtureCache(dir);
          console.log(`Cache before q4 ${JSON.stringify(cache.after_q3)}`);
        }
        const { question, expected } = questions[index]!;
        const beforeFaults = majorFaults(`/proc/${front.pid}`);
        const sentAt = Date.now();
        const response = await workerFetch(`${origin}/v1/source/answer`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, corpus_ids: stores.map(store => store.corpusId) }),
          signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${await response.text()}`);
        const answer = await response.json() as SourceIndexAnswerResult;
        const afterFaults = majorFaults(`/proc/${front.pid}`);
        const scopeSwap = scopeBytes(scope, 'memory.swap.current');
        const http_ms = Date.now() - sentAt;
        const data = readFileSync(tracePath);
        const rows = data.subarray(lastTraceSize).toString('utf8').trim().split('\n').filter(Boolean)
          .map(line => JSON.parse(line) as SourceAnswerLatencyLedgerRecord);
        lastTraceSize = data.length;
        const ask: Ask = {
          label, ready: sentAt >= readyAt ? 'after' : 'before', expected, http_ms,
          expected_item_cited: answer.evidence.some(item => item.corpus_id === expected.corpus_id && item.provider_item_id === expected.provider_item_id),
          front_majflt: beforeFaults === null || afterFaults === null ? null : afterFaults - beforeFaults,
          scope_swap_used_bytes: scopeSwap, searched_corpora: answer.audit.searched_corpora,
          ...askTimings(rows, answer),
        };
        asks.push(ask);
        console.log(askLines(ask).join('\n'));
      }
    } finally {
      await reportDisk('six Asks', askStart, takeDiskSamples(), newSiteTotals());
    }
    frontThreads = procNumber(optionalText(`/proc/${front.pid}/status`), 'Threads');
    scheduler = readEngineStatusSnapshot(engineStatusSnapshotPath(env))?.snapshot.scheduler as SourceSchedulerStatus | undefined;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    console.error('Ask benchmark run failed:', cause);
  } finally {
    stopChildren();
    await Promise.all(children.map(child => child.exited));
    await Promise.all(pumps);
    process.off('exit', stopChildren);
    stub.stop(true);
    rmSync(temp, { recursive: true, force: true });
  }
  const result = {
    sha: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
    build, scope, limits, actual, swap_devices: optionalText('/proc/swaps')?.trim().split('\n').slice(1).length ?? null,
    seconds_idle: args.secondsIdle, extra_env_keys: Object.keys(args.extraEnv), ready, cache,
    questions, idle, asks, disk_attribution: diskReports.map(({ lines, ...report }) => report), front_threads: frontThreads, model_calls: calls, scheduler, reproduction: reproduction(asks),
    ...(error ? { error, engine_log_tails: tails } : {}),
  };
  const verdict = `${result.reproduction.verdict} ${JSON.stringify(result.reproduction.observations)}`;
  console.log(verdict);
  const summary = [
    '# Ask benchmark', '', `**${result.reproduction.verdict}**`, '',
    `Scale ${build.scale}, ${build.dimension} dimensions, build ${build.build_ms} ms, stores ${build.store_bytes} bytes, total database bytes ${build.total_bytes}.`,
    `Systemd scope · MemoryMax ${actual.memory_max ?? 'n/a'} bytes · MemorySwapMax ${actual.memory_swap_max ?? 'n/a'} bytes · active swap devices ${result.swap_devices ?? 'n/a'}.`,
    `Front threads ${frontThreads ?? 'n/a'} · loopback calls \`${JSON.stringify(calls)}\`.`,
    `Embedding sweeps reporting a successful pass ${scheduler?.sources.flatMap(source => source.tasks).filter(task => task.kind === 'embed' && task.last_success_at).length ?? 'n/a'}.`,
    ...(error ? ['', `Run error: ${error}`] : []),
    '', '## Reproduction measurements', '', '~~~text', verdict, '~~~',
    '', '## Ready, idle, and cache', '', '~~~text', ...Object.values(ready).map(value => value.line),
    ...idle.map(sample => JSON.stringify(sample)), JSON.stringify(cache), '~~~',
    '', '## SQL disk attribution', '', '~~~text', ...diskReports.flatMap(report => report.lines), '~~~',
    '', '## Asks', '', '~~~text', ...asks.map(ask => askLines(ask)[0]!), '~~~',
    '', '<details><summary>Per-store trace fields</summary>', '', '~~~text', ...asks.flatMap(askLines), '~~~', '', '</details>', '',
  ].join('\n');
  writeFileSync(join(dir, 'ask-bench.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(dir, 'ask-bench.md'), summary);
  if (error) {
    for (const role of roles) console.error(`${role} log tail:\n${tails[role]}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2);
  if (command !== 'build' && command !== 'run' && command !== 'build-store') {
    throw new Error('Usage: ask-bench.ts build|run --dir /tmp/PATH [--scale 1.0] [--seconds-idle 300] [--memory-max SIZE] [--memory-swap-max SIZE] [--extra-env "KEY=VALUE ..."] [--scope user|system]');
  }
  const args = parseArgs(rawArgs);
  if (command === 'build') {
    await build(args.dir, args.scale);
  } else if (command === 'build-store') {
    await buildStore(args.dir, args.scale, args.storeIndex ?? -1);
  } else {
    const receipt = JSON.parse(readFileSync(buildPath(args.dir), 'utf8')) as BuildReceipt;
    if (receipt.version !== VERSION || receipt.dimension !== DIMENSION) throw new Error('Build the current fixture version first.');
    const limits = limitsFor(receipt, args);
    if (args.mode === 'inside') {
      await run(args, receipt, limits);
    } else {
      const manager = args.mode === 'system'
        ? ['sudo', 'systemd-run', `--uid=${process.getuid!()}`, `--gid=${process.getgid!()}`, `--setenv=PATH=${process.env.PATH ?? ''}`]
        : ['systemd-run', '--user'];
      const inner = rawArgs.filter((_, index) => rawArgs[index - index % 2] !== '--scope');
      const child = Bun.spawn([
        ...manager, '--scope', '--quiet', '-p', `MemoryMax=${limits.memory_max}`, '-p', `MemorySwapMax=${limits.memory_swap_max}`, '-p', 'OOMPolicy=continue', '--',
        process.execPath, import.meta.path, 'run', ...inner, '--scope', 'inside',
      ], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
      const code = await child.exited;
      if (code !== 0) {
        console.error(`Ask benchmark scope command failed (${child.signalCode ?? `exit code ${code}`}). See the command and engine errors above.`);
        process.exitCode = code;
      }
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error('Ask benchmark failed:', error);
    process.exitCode = 1;
  }
}
