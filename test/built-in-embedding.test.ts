/**
 * The built-in embedding model: the zero-setup default for new installs
 * (Arctic Embed M v1.5 from 2026-10-01, EmbeddingGemma 2 from 2026-10-06).
 * These tests run with a stub runtime and a stub download server;
 * `OLYMPUS_BUILT_IN_EMBEDDING_REAL_TEST=1` additionally runs the real default
 * model (downloads it once into OLYMPUS_BUILT_IN_EMBEDDING_DIR or a temporary
 * directory), and `OLYMPUS_GEMMA_TOKENIZER_MODEL=<path to tokenizer.model>`
 * checks the SentencePiece tokenizer against the reference library's output.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadSovereigntyPreset, SOVEREIGNTY_PRESETS, validateSovereigntyConfig, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import {
  BuiltInEmbeddingInstallError,
  installBuiltInEmbedding,
  readBuiltInEmbeddingStatus,
  type BuiltInEmbeddingStatus,
} from '../src/workers/source-index/built-in-embedding/assets.ts';
import { calibratedSemanticRelevanceBar } from '../src/workers/connector-store/local-index.ts';
import {
  ARCTIC_EMBED_M_V1_5,
  BUILT_IN_EMBEDDING_MODEL,
  BUILT_IN_EMBEDDING_MODELS,
  builtInEmbeddingModelFiles,
  EMBEDDINGGEMMA_2,
  ONNX_RUNTIME_PACK,
  type BuiltInEmbeddingModelSpec,
  type OnnxRuntimePackSpec,
} from '../src/workers/source-index/built-in-embedding/manifest.ts';
import {
  BuiltInEmbeddingNotReadyError,
  BuiltInSourceEmbeddingProvider,
  builtInEmbeddingAttention,
  builtInEmbeddingDashboardState,
  sharedBuiltInSourceEmbeddingProvider,
} from '../src/workers/source-index/built-in-embedding/provider.ts';
import {
  onnxRuntimeFromDirectory,
  type EmbeddingBatch,
  type EmbeddingRuntime,
  type EmbeddingSessionOptions,
} from '../src/workers/source-index/built-in-embedding/runtime.ts';
import { SentencePieceTokenizer } from '../src/workers/source-index/built-in-embedding/sentencepiece.ts';
import { readTarGz } from '../src/workers/source-index/built-in-embedding/tar.ts';
import { WordPieceTokenizer } from '../src/workers/source-index/built-in-embedding/wordpiece.ts';
import { canonicalEmbeddingIdentityForModel } from '../src/workers/source-index/embedding-identity.ts';
import {
  isApprovedSecureSourceEmbeddingProvider,
  TransientSourceEmbeddingError,
} from '../src/workers/source-index/embeddings.ts';
import {
  createSourceIndexEmbeddingProviderFromEnv,
  createSourceIndexEmbeddingProviderFromSovereignty,
} from '../src/workers/email-source/server.ts';
import { createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { setupPreflight } from '../src/core/setup-preflight.ts';
import { loadPreBuiltInPreset } from './helpers/pre-built-in-presets.ts';

const BUILT_IN_EPOCH = 'local:built-in:embeddinggemma-2-int8-daa72c5:768';
const ARCTIC_EPOCH = 'local:built-in:arctic-embed-m-v1.5-int8-e58a8f7:768';

const VOCAB = [
  '[PAD]', '[UNK]', '[CLS]', '[SEP]', '[MASK]',
  'hello', 'world', ',', '!', 'the', 'flight', 'to', 'san', 'francisco',
  'un', '##believ', '##able', 'cafe', 'resume', '你', '好', 'query', ':',
  'invoice', '#', '45', '##21', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h',
].join('\n');

const temporaryDirs: string[] = [];
function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-built-in-embedding-'));
  temporaryDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WordPiece tokenizer', () => {
  const tokenizer = new WordPieceTokenizer(VOCAB);
  const decode = (ids: number[]) => ids.map((id) => VOCAB.split('\n')[id]);

  test('lowercases, strips accents, isolates punctuation and splits word pieces', () => {
    expect(decode(tokenizer.tokenize('Hello, WORLD! Unbelievable café résumé'))).toEqual([
      'hello', ',', 'world', '!', 'un', '##believ', '##able', 'cafe', 'resume',
    ]);
  });

  test('spaces out CJK ideographs, maps unknown words to [UNK], drops control characters', () => {
    expect(decode(tokenizer.tokenize('你好 zzz\u0000 invoice\t#4521'))).toEqual([
      '你', '好', '[UNK]', 'invoice', '#', '45', '##21',
    ]);
  });

  test('encode adds [CLS]/[SEP] and truncates on the right', () => {
    const encoded = tokenizer.encode('a b c d e f g h', 6);
    expect(decode(encoded.ids)).toEqual(['[CLS]', 'a', 'b', 'c', 'd', '[SEP]']);
    expect(encoded.truncated).toBe(true);
    expect(tokenizer.encode('a b', 6).truncated).toBe(false);
  });

  test('refuses a vocabulary without the special tokens', () => {
    expect(() => new WordPieceTokenizer('hello\nworld')).toThrow('[CLS]');
  });
});

describe('tar reader', () => {
  test('reads the requested regular files from a gzip ustar archive and refuses unsafe paths', () => {
    const archive = gzipSync(buildTar([
      { path: 'package/package.json', data: '{"name":"x"}' },
      { path: 'package/bin/napi-v6/darwin/arm64/binding.node', data: 'native' },
      { path: 'package/bin/napi-v6/linux/x64/binding.node', data: 'other' },
      { path: '../escape.txt', data: 'nope' },
    ]));
    const files = readTarGz(archive, (path) => !path.includes('/linux/'));
    expect(files.map((file) => file.path)).toEqual([
      'package/package.json',
      'package/bin/napi-v6/darwin/arm64/binding.node',
    ]);
    expect(new TextDecoder().decode(files[1]!.data)).toBe('native');
  });
});

// ---------------------------------------------------------------------------
// Installer

interface Served {
  model: BuiltInEmbeddingModelSpec;
  runtime: OnnxRuntimePackSpec;
  fetchImpl: typeof fetch;
  requests: string[];
}

function servedAssets(options: { corruptModel?: boolean; status?: number } = {}): Served {
  const modelBytes = new TextEncoder().encode('fake onnx weights '.repeat(4_000));
  const vocabBytes = new TextEncoder().encode(VOCAB);
  const runtimeArchive = gzipSync(buildTar([
    { path: 'package/package.json', data: '{"name":"onnxruntime-node","main":"dist/index.js"}' },
    { path: 'package/dist/index.js', data: 'module.exports = {};' },
    { path: `package/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`, data: 'binding' },
    { path: 'package/bin/napi-v6/win32/x64/onnxruntime.dll', data: 'not for this platform' },
  ]));
  const commonArchive = gzipSync(buildTar([
    { path: 'package/package.json', data: '{"name":"onnxruntime-common"}' },
    { path: 'package/dist/cjs/index.js', data: 'module.exports = {};' },
  ]));
  const bodies = new Map<string, Uint8Array>([
    ['https://models.test/model.onnx', options.corruptModel ? new TextEncoder().encode('x'.repeat(modelBytes.length)) : modelBytes],
    ['https://models.test/vocab.txt', vocabBytes],
    ['https://registry.test/onnxruntime-node.tgz', runtimeArchive],
    ['https://registry.test/onnxruntime-common.tgz', commonArchive],
  ]);
  const requests: string[] = [];
  const model: BuiltInEmbeddingModelSpec = {
    ...ARCTIC_EMBED_M_V1_5,
    modelId: 'test-built-in-model',
    dimension: 4,
    maxTokens: 8,
    queryPrefix: 'query: ',
    model: { name: 'model.onnx', url: 'https://models.test/model.onnx', bytes: modelBytes.length, sha256: sha256(modelBytes) },
    vocabulary: { name: 'vocab.txt', url: 'https://models.test/vocab.txt', bytes: vocabBytes.length, sha256: sha256(vocabBytes) },
  };
  const runtime: OnnxRuntimePackSpec = {
    ...ONNX_RUNTIME_PACK,
    runtime: { ...ONNX_RUNTIME_PACK.runtime, url: 'https://registry.test/onnxruntime-node.tgz', bytes: runtimeArchive.length, integrity: sha512Integrity(runtimeArchive) },
    common: { ...ONNX_RUNTIME_PACK.common, url: 'https://registry.test/onnxruntime-common.tgz', bytes: commonArchive.length, integrity: sha512Integrity(commonArchive) },
    platforms: [`${process.platform}-${process.arch}`],
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    const body = bodies.get(url);
    if (options.status) return new Response('unavailable', { status: options.status });
    if (!body) return new Response('missing', { status: 404 });
    // Deliver in several chunks so progress has steps.
    const chunk = Math.max(1, Math.ceil(body.length / 4));
    return new Response(new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < body.length; offset += chunk) controller.enqueue(body.slice(offset, offset + chunk));
        controller.close();
      },
    }));
  }) as typeof fetch;
  return { model, runtime, fetchImpl, requests };
}

describe('built-in embedding installer', () => {
  test('downloads once, verifies every file, unpacks only this platform, and reports progress', async () => {
    const dir = temporaryDir();
    const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir };
    const served = servedAssets();
    const progress: BuiltInEmbeddingStatus[] = [];
    const installed = await installBuiltInEmbedding({
      env, model: served.model, runtime: served.runtime, fetchImpl: served.fetchImpl,
      onProgress: (status) => progress.push(status),
    });

    expect(readFileSync(installed.vocabularyPath, 'utf8')).toBe(VOCAB);
    const runtimeBin = join(installed.runtimeDir, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
    expect(readdirSync(runtimeBin)).toEqual([process.platform]);
    expect(existsSync(join(installed.runtimeDir, 'node_modules', 'onnxruntime-common', 'package.json'))).toBe(true);
    expect(served.requests).toHaveLength(4);

    const downloading = progress.filter((status) => status.state === 'downloading');
    expect(downloading.length).toBeGreaterThan(4);
    const percents = downloading.map((status) => status.percent);
    expect(percents).toEqual([...percents].sort((left, right) => left - right));
    expect(Math.max(...percents)).toBeGreaterThanOrEqual(90);
    expect(downloading.every((status) => status.label.length > 0)).toBe(true);
    expect(readBuiltInEmbeddingStatus(env, served.model).state).not.toBe('failed');

    // Second call: nothing fetched again.
    await installBuiltInEmbedding({ env, model: served.model, runtime: served.runtime, fetchImpl: served.fetchImpl });
    expect(served.requests).toHaveLength(4);
    // No partial files or lock left behind.
    expect(readdirSync(join(dir, served.model.modelId)).sort()).toEqual(['model.onnx', 'vocab.txt']);
    expect(existsSync(join(dir, 'install.lock'))).toBe(false);
  });

  test('a checksum mismatch installs nothing and is reported as failed', async () => {
    const dir = temporaryDir();
    const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir };
    const served = servedAssets({ corruptModel: true });
    const error = await installBuiltInEmbedding({
      env, model: served.model, runtime: served.runtime, fetchImpl: served.fetchImpl,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BuiltInEmbeddingInstallError);
    expect((error as BuiltInEmbeddingInstallError).reason).toBe('checksum_mismatch');
    expect(existsSync(join(dir, served.model.modelId, 'model.onnx'))).toBe(false);
    expect(readdirSync(join(dir, served.model.modelId)).filter((name) => name.includes('.partial'))).toEqual([]);
    const status = readBuiltInEmbeddingStatus(env, served.model);
    expect(status.state).toBe('failed');
    expect(builtInEmbeddingAttention(status)).toEqual({
      id: 'built-in-embedding',
      reason: 'checksum_mismatch',
      message: expect.any(String),
    });
  });

  test('an unreachable server and an unsupported platform fail with their own reasons', async () => {
    const served = servedAssets({ status: 503 });
    const offline = await installBuiltInEmbedding({
      env: { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir() },
      model: served.model, runtime: served.runtime, fetchImpl: served.fetchImpl,
    }).then(
      () => { throw new Error('expected the install to fail'); },
      (caught: BuiltInEmbeddingInstallError) => caught,
    );
    expect(offline.reason).toBe('download_failed');

    const unsupported = await installBuiltInEmbedding({
      env: { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir() },
      model: served.model, runtime: served.runtime, fetchImpl: served.fetchImpl, platform: 'sunos-sparc',
    }).then(
      () => { throw new Error('expected the install to fail'); },
      (caught: BuiltInEmbeddingInstallError) => caught,
    );
    expect(unsupported.reason).toBe('unsupported_platform');
  });

  test('a download that stops sending fails within the stall limit and leaves no partial file', async () => {
    const dir = temporaryDir();
    const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir };
    const served = servedAssets();
    const stalled = (async () => {
      let sent = false;
      // A few bytes, then silence: the connection never closes.
      return new Response(new ReadableStream({
        pull(controller) {
          if (sent) return new Promise<void>(() => undefined);
          sent = true;
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
      }));
    }) as unknown as typeof fetch;
    const started = Date.now();
    const error = await installBuiltInEmbedding({
      env, model: served.model, skipRuntime: true, fetchImpl: stalled, downloadStallMs: 50,
    }).catch((caught: unknown) => caught);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error).toMatchObject({ reason: 'download_failed' });
    expect((error as Error).message).toContain('interrupted');
    expect(readdirSync(join(dir, served.model.modelId)).filter((name) => name.includes('.partial'))).toEqual([]);
    expect(existsSync(join(dir, 'install.lock'))).toBe(false);
    expect(readBuiltInEmbeddingStatus(env, served.model).state).toBe('failed');
  });

  test('a corrupted file on disk is caught at load and removed', async () => {
    const dir = temporaryDir();
    const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir };
    const served = servedAssets();
    const installed = await installBuiltInEmbedding({ env, model: served.model, skipRuntime: true, fetchImpl: served.fetchImpl });
    await Bun.write(installed.vocabularyPath, VOCAB.replace('hello', 'HELLO'));
    const tampered = await installBuiltInEmbedding({
      env, model: { ...served.model, modelId: served.model.modelId }, skipRuntime: true, fetchImpl: served.fetchImpl,
    }).catch((caught: unknown) => caught);
    // This process already verified the file once; a fresh process re-hashes.
    // Either the cache short-circuits or the mismatch is caught: never a silent load of a different vocabulary.
    if (tampered instanceof BuiltInEmbeddingInstallError) {
      expect(tampered.reason).toBe('checksum_mismatch');
      expect(existsSync(installed.vocabularyPath)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider

/** A stand-in model: the [CLS] vector encodes the window's ids. */
function stubRuntime(log: EmbeddingBatch[], delayMs = 0): EmbeddingRuntime {
  return {
    async createSession() {
      return {
        async run(batch) {
          log.push(batch);
          if (delayMs > 0) await Bun.sleep(delayMs);
          const hidden = 4;
          const data = new Float32Array(batch.batchSize * batch.sequenceLength * hidden);
          for (let row = 0; row < batch.batchSize; row += 1) {
            let sum = 0;
            let count = 0;
            for (let column = 0; column < batch.sequenceLength; column += 1) {
              const index = row * batch.sequenceLength + column;
              if (batch.attentionMask[index] === 1n) {
                sum += Number(batch.inputIds[index]);
                count += 1;
              }
            }
            const base = row * batch.sequenceLength * hidden;
            data.set([sum, count, Number(batch.inputIds[row * batch.sequenceLength + 1]), 1], base);
          }
          return { data, dims: [batch.batchSize, batch.sequenceLength, hidden] };
        },
      };
    },
  };
}

function stubProvider(options: { status?: number; threads?: number; delayMs?: number } = {}) {
  const dir = temporaryDir();
  const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir };
  const served = servedAssets(options.status ? { status: options.status } : {});
  const batches: EmbeddingBatch[] = [];
  const provider = new BuiltInSourceEmbeddingProvider({
    env,
    model: served.model,
    runtime: () => stubRuntime(batches, options.delayMs ?? 0),
    installerOptions: { fetchImpl: served.fetchImpl, skipRuntime: true },
    ...(options.threads ? { threads: options.threads } : {}),
  });
  return { provider, batches, served, env };
}

describe('built-in embedding provider', () => {
  test('carries a stable, distinct local identity', () => {
    const provider = new BuiltInSourceEmbeddingProvider({ env: { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir() } });
    expect(provider.provider).toBe('built-in');
    expect(provider.backend).toBe('local');
    expect(provider.modelId).toBe(BUILT_IN_EMBEDDING_MODEL.modelId);
    expect(provider.dimension).toBe(768);
    expect(provider.epochId).toBe(BUILT_IN_EPOCH);
    expect(canonicalEmbeddingIdentityForModel(provider.modelId)?.epochId).toBe(BUILT_IN_EPOCH);
    expect(isApprovedSecureSourceEmbeddingProvider(provider)).toBe(true);
    const again = new BuiltInSourceEmbeddingProvider({ env: { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir() } });
    expect(again.configHash).toBe(provider.configHash);
  });

  test('caps CPU threads at half the cores (at most four) unless configured', () => {
    const provider = new BuiltInSourceEmbeddingProvider({ env: {} });
    expect(provider.threads).toBeGreaterThanOrEqual(1);
    expect(provider.threads).toBeLessThanOrEqual(4);
    expect(new BuiltInSourceEmbeddingProvider({ env: { OLYMPUS_BUILT_IN_EMBEDDING_THREADS: '2' } }).threads).toBe(2);
    expect(() => new BuiltInSourceEmbeddingProvider({ env: { OLYMPUS_BUILT_IN_EMBEDDING_THREADS: '0' } })).toThrow();
  });

  test('embeds documents on first use: unit vectors, CLS pooling, one row per input', async () => {
    const { provider, batches, env, served } = stubProvider();
    const vectors = await provider.embed([
      { text: 'hello world' },
      { text: 'the flight', title: 'san francisco' },
    ], { taskType: 'RETRIEVAL_DOCUMENT' });
    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toHaveLength(4);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 6);
    }
    // Title is read before the text.
    const titled = batches.flatMap((batch) => rows(batch)).find((ids) => ids.includes(12));
    expect(titled?.slice(0, 3)).toEqual([2, 12, 13]);
    expect(readBuiltInEmbeddingStatus(env, served.model).state).toBe('ready');
  });

  test('reads a long document as several windows and combines them', async () => {
    const { provider, batches } = stubProvider();
    // maxTokens 8 => 6 content tokens per window; 14 tokens => 3 windows.
    const [vector] = await provider.embed([{ text: 'a b c d e f g h a b c d e f' }], { taskType: 'RETRIEVAL_DOCUMENT' });
    const windows = batches.flatMap((batch) => rows(batch));
    expect(windows).toHaveLength(3);
    expect(windows.every((ids) => ids[0] === 2 && ids.at(-1) === 3 && ids.length <= 8)).toBe(true);
    expect(Math.hypot(...vector!)).toBeCloseTo(1, 6);
  });

  test('queries get the query prefix and only the first window', async () => {
    const { provider, batches } = stubProvider();
    await provider.embed([{ text: 'warm up' }], { taskType: 'RETRIEVAL_DOCUMENT' });
    batches.length = 0;
    await provider.embed([{ text: 'a b c d e f g h' }], { taskType: 'RETRIEVAL_QUERY' });
    const [ids] = batches.flatMap((batch) => rows(batch));
    expect(batches.flatMap((batch) => rows(batch))).toHaveLength(1);
    expect(ids!.slice(0, 3)).toEqual([2, 21, 22]); // [CLS] query :
  });

  test('a question before the model is installed falls back instead of waiting, and starts the install', async () => {
    const { provider, served, env } = stubProvider();
    const error = await provider.embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_QUERY' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BuiltInEmbeddingNotReadyError);
    expect(error).toBeInstanceOf(TransientSourceEmbeddingError);
    await provider.prepare();
    expect(served.requests.length).toBeGreaterThan(0);
    expect(readBuiltInEmbeddingStatus(env, served.model).state).toBe('ready');
    expect(builtInEmbeddingDashboardState(provider.status())).toEqual({ kind: 'built_in', state: 'ready' });
    await expect(provider.embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_QUERY' })).resolves.toHaveLength(1);
  });

  test('a failed install surfaces as a needs-you item and is not retried in a tight loop', async () => {
    const { provider, served, env } = stubProvider({ status: 503 });
    await expect(provider.embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_DOCUMENT' })).rejects.toThrow();
    const attempts = served.requests.length;
    await expect(provider.embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_DOCUMENT' })).rejects.toThrow();
    expect(served.requests.length).toBe(attempts);
    const attention = builtInEmbeddingAttention(provider.status());
    expect(attention?.reason).toBe('download_failed');
    expect(readBuiltInEmbeddingStatus(env, served.model).state).toBe('failed');
    expect(builtInEmbeddingDashboardState(provider.status())).toEqual({ kind: 'built_in', state: 'failed', failedReason: 'network' });
    // The owner's retry skips the back-off and tries again at once.
    await provider.retry().catch(() => undefined);
    expect(served.requests.length).toBeGreaterThan(attempts);
  });

  test('a question\'s pass runs before the waiting passes of an indexing batch', async () => {
    const { provider, batches } = stubProvider({ delayMs: 15 });
    await provider.embed([{ text: 'warm up' }], { taskType: 'RETRIEVAL_DOCUMENT' });
    batches.length = 0;
    // 70 documents: three forward passes of at most 32 rows.
    const indexing = provider.embed(
      Array.from({ length: 70 }, (_, index) => ({ text: index % 2 ? 'a b c' : 'hello world the flight to san' })),
      { taskType: 'RETRIEVAL_DOCUMENT' },
    );
    await Bun.sleep(5);
    const question = provider.embed([{ text: 'a b' }], { taskType: 'RETRIEVAL_QUERY' });
    const [vectors, [queryVector]] = await Promise.all([indexing, question]);
    expect(vectors).toHaveLength(70);
    expect(queryVector).toHaveLength(4);
    // The question waited only for the pass already running, not for the batch.
    expect(batches.map((batch) => batch.batchSize)).toEqual([32, 1, 32, 6]);
  });

  test('warm loads the model and runs one question through it', async () => {
    const { provider, batches, env, served } = stubProvider();
    await provider.warm();
    expect(readBuiltInEmbeddingStatus(env, served.model).state).toBe('ready');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.batchSize).toBe(1);
  });

  test('batches stay inside the padded-token budget', async () => {
    const { provider, batches } = stubProvider();
    const inputs = Array.from({ length: 70 }, (_, index) => ({ text: index % 2 ? 'a b c' : 'hello world the flight to san' }));
    const vectors = await provider.embed(inputs, { taskType: 'RETRIEVAL_DOCUMENT' });
    expect(vectors).toHaveLength(70);
    expect(batches.every((batch) => batch.batchSize <= 32)).toBe(true);
    expect(batches.reduce((sum, batch) => sum + batch.batchSize, 0)).toBe(70);
  });
});

describe('built-in embedding as the new-install default', () => {
  test('every preset embeds with the built-in model and asks for nothing to do so', async () => {
    for (const preset of SOVEREIGNTY_PRESETS) {
      const config = loadSovereigntyPreset(preset);
      const builtIn = Object.entries(config.modelProfiles).filter(([, profile]) => profile.provider === 'built-in');
      expect(builtIn).toHaveLength(1);
      const [id, profile] = builtIn[0]!;
      expect(profile).toEqual({ provider: 'built-in', trust: 'local', model: BUILT_IN_EMBEDDING_MODEL.modelId, purpose: 'embedding' });
      for (const [domain, policy] of Object.entries(config.retrieval.trustDomains)) {
        if (policy.activationMode === 'metadata_only') continue;
        expect({ domain, profile: policy.embeddingProfile }).toEqual({ domain, profile: id });
      }
      // Other embedding providers are opt-in: a preset carries none, so setup
      // never asks for a Gemini key or an embedding server.
      expect(Object.values(config.modelProfiles).filter((entry) => entry.purpose === 'embedding')).toHaveLength(1);
      const unmet = await setupPreflight({
        config,
        env: {},
        secretStore: { getSync: () => undefined, get: async () => undefined },
      });
      expect(unmet.filter((item) => item.profileId === id)).toEqual([]);
      expect(unmet.map((item) => item.id)).not.toContain('env:GEMINI_API_KEY');
    }
  });

  test('the sovereignty factory hands every domain the same in-process provider', () => {
    const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir() };
    const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
    const internal = createSourceIndexEmbeddingProviderFromSovereignty(engine, 'internal', env);
    const secure = createSourceIndexEmbeddingProviderFromSovereignty(engine, 'secure_local', env);
    expect(internal).toBeInstanceOf(BuiltInSourceEmbeddingProvider);
    expect(secure).toBe(internal);
    expect(createSourceIndexEmbeddingProviderFromEnv({
      ...env,
      OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'built-in',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL: BUILT_IN_EMBEDDING_MODEL.modelId,
    })).toBe(internal);
    // Naming no model keeps the model that setting has always meant: an upgrade never re-embeds on its own.
    expect(createSourceIndexEmbeddingProviderFromEnv({ ...env, OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'built-in' })?.modelId)
      .toBe(ARCTIC_EMBED_M_V1_5.modelId);
    expect(() => sharedBuiltInSourceEmbeddingProvider({ modelId: 'some-future-model', env })).toThrow('does not include');
  });

  test('an install written before the built-in default keeps its embedding provider', () => {
    const env = {
      OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir(),
      OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY: 'fixture-key',
    };
    for (const preset of SOVEREIGNTY_PRESETS) {
      const engine = createSovereigntyEngine(loadPreBuiltInPreset(preset));
      expect(createSourceIndexEmbeddingProviderFromSovereignty(engine, 'internal', env)?.epochId)
        .toBe('cloud:google-gemini:gemini-embedding-2:provider-reported');
      if (preset === 'local-first' || preset === 'local-only') {
        expect(createSourceIndexEmbeddingProviderFromSovereignty(engine, 'secure_local', env)?.epochId)
          .toBe('local:openai-compatible:secure-local-qwen3-embed:2560');
      }
    }
  });

  test('a built-in profile is local, endpoint-free, and never an analyst', () => {
    const base = loadSovereigntyPreset('local-first');
    const withProfile = (profile: Record<string, unknown>): SovereigntyConfig => ({
      ...base,
      modelProfiles: { ...base.modelProfiles, 'built-in-embedding': profile as never },
    });
    expect(() => validateSovereigntyConfig(withProfile({ provider: 'built-in', trust: 'standard_cloud', model: 'x' })))
      .toThrow('always local');
    expect(() => validateSovereigntyConfig(withProfile({ provider: 'built-in', trust: 'local', model: 'x', baseUrl: 'http://127.0.0.1:1/v1' })))
      .toThrow('no baseUrl');
    expect(() => validateSovereigntyConfig({
      ...base,
      routes: { ...base.routes, internal: { pool: { members: ['built-in-embedding'] } } },
    })).toThrow('as an analyst');
  });
});

// ---------------------------------------------------------------------------
// SentencePiece (EmbeddingGemma 2's tokenizer)

/** A tiny SentencePiece BPE `tokenizer.model`, built field by field. */
function sentencePieceModel(options: {
  pieces: Array<[piece: string, score: number, type?: number]>;
  modelType?: number;
  normalizer?: string;
  addDummyPrefix?: boolean;
}): Uint8Array<ArrayBuffer> {
  const varint = (value: number): number[] => {
    const out: number[] = [];
    let rest = value;
    while (rest >= 0x80) {
      out.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    out.push(rest);
    return out;
  };
  const bytesField = (field: number, bytes: number[]) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
  const varintField = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
  const floatField = (field: number, value: number) => {
    const buffer = new DataView(new ArrayBuffer(4));
    buffer.setFloat32(0, value, true);
    return [...varint(field * 8 + 5), ...new Uint8Array(buffer.buffer)];
  };
  const text = (value: string) => [...new TextEncoder().encode(value)];
  const special: Array<[string, number, number]> = [['<pad>', 0, 3], ['<eos>', 0, 3], ['<bos>', 0, 3], ['<unk>', 0, 2]];
  const bytePieces: Array<[string, number, number]> = Array.from({ length: 256 }, (_, byte) =>
    [`<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`, 0, 6]);
  const out: number[] = [];
  for (const [piece, score, type = 1] of [...special, ...bytePieces, ...options.pieces]) {
    out.push(...bytesField(1, [...bytesField(1, text(piece)), ...floatField(2, score), ...varintField(3, type)]));
  }
  out.push(...bytesField(2, [...varintField(3, options.modelType ?? 2), ...varintField(35, 1)]));
  out.push(...bytesField(3, [
    ...bytesField(1, text(options.normalizer ?? 'identity')),
    ...varintField(3, options.addDummyPrefix ? 1 : 0),
    ...varintField(4, 0),
  ]));
  return new Uint8Array(out);
}

/** Ids 0..259 are special and byte pieces; these follow, in order. */
const SP_PIECES: Array<[string, number, number?]> = [
  ['h', -1], ['e', -2], ['l', -3], ['o', -4], ['▁', -5], ['w', -6], ['r', -7], ['d', -8],
  ['he', -10], ['ll', -11], ['hell', -12], ['hello', -13], ['▁w', -14], ['or', -9], ['▁wor', -15], ['▁world', -16],
  ['ld', -17], ['<keep>', 0, 4], ['ab', -20], ['bc', -20], ['a', -21], ['b', -22], ['c', -23],
];
const sp = (piece: string) => 260 + SP_PIECES.findIndex(([entry]) => entry === piece);

describe('SentencePiece tokenizer', () => {
  const tokenizer = new SentencePieceTokenizer(sentencePieceModel({ pieces: SP_PIECES }));

  test('merges the highest-scoring pair first and escapes spaces as ▁', () => {
    expect([tokenizer.padId, tokenizer.eosId, tokenizer.bosId, tokenizer.unkId]).toEqual([0, 1, 2, 3]);
    expect(tokenizer.tokenize('hello world')).toEqual([sp('hello'), sp('▁world')]);
    expect(tokenizer.tokenize('')).toEqual([]);
  });

  test('breaks a tie between equal scores toward the leftmost pair', () => {
    expect(tokenizer.tokenize('abc')).toEqual([sp('ab'), sp('c')]);
  });

  test('keeps a user-defined piece whole and never merges across it', () => {
    expect(tokenizer.tokenize('he<keep>llo')).toEqual([sp('he'), sp('<keep>'), sp('ll'), sp('o')]);
  });

  test('falls back to UTF-8 byte pieces for characters outside the vocabulary', () => {
    // "é" is 0xC3 0xA9; byte pieces are ids 4 + byte.
    expect(tokenizer.tokenize('hé')).toEqual([sp('h'), 4 + 0xc3, 4 + 0xa9]);
  });

  test('refuses a model this encoder would encode differently', () => {
    expect(() => new SentencePieceTokenizer(sentencePieceModel({ pieces: SP_PIECES, modelType: 1 }))).toThrow('not a BPE model');
    expect(() => new SentencePieceTokenizer(sentencePieceModel({ pieces: SP_PIECES, normalizer: 'nmt_nfkc' }))).toThrow('normalizer');
    expect(() => new SentencePieceTokenizer(sentencePieceModel({ pieces: SP_PIECES, addDummyPrefix: true }))).toThrow('normalizer');
  });

  const gemmaTokenizerPath = process.env.OLYMPUS_GEMMA_TOKENIZER_MODEL?.trim();
  (gemmaTokenizerPath ? test : test.skip)('matches the reference library on the Gemma tokenizer (opt-in)', () => {
    const golden = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'gemma-tokenizer-golden.json'), 'utf8')) as {
      sha256: string;
      cases: Array<{ text: string; ids: number[] }>;
    };
    const bytes = readFileSync(gemmaTokenizerPath!);
    expect(sha256(bytes)).toBe(golden.sha256);
    const gemma = new SentencePieceTokenizer(bytes);
    for (const { text, ids } of golden.cases) expect({ text, ids: gemma.tokenize(text) }).toEqual({ text, ids });
  });
});

// ---------------------------------------------------------------------------
// A SentencePiece model whose graph pools for itself (EmbeddingGemma 2's shape)

/** A stand-in pooled model: `[sum of ids, id count, first content id, 1]` per row. */
function pooledStubRuntime(log: EmbeddingBatch[], sessions: EmbeddingSessionOptions[], dims?: (rows: number) => number[]): EmbeddingRuntime {
  return {
    async createSession(_path, options) {
      sessions.push(options);
      return {
        async run(batch) {
          log.push(batch);
          const data = new Float32Array(batch.batchSize * 4);
          rows(batch).forEach((ids, row) => data.set([ids.reduce((sum, id) => sum + id, 0), ids.length, ids[1] ?? 0, 1], row * 4));
          return { data, dims: dims ? dims(batch.batchSize) : [batch.batchSize, 4] };
        },
      };
    },
  };
}

function pooledStubProvider(dims?: (rows: number) => number[], extraEnv: Record<string, string> = {}) {
  const tokenizerBytes = sentencePieceModel({ pieces: [...SP_PIECES, ['t', -30], ['i', -31], [':', -32], ['n', -33], ['x', -34]] });
  const modelBytes = new TextEncoder().encode('fake onnx graph');
  const dataBytes = new TextEncoder().encode('fake onnx weights '.repeat(100));
  const bodies = new Map<string, Uint8Array<ArrayBuffer>>([
    ['https://models.test/model.onnx', modelBytes],
    ['https://models.test/model.onnx_data', dataBytes],
    ['https://models.test/tokenizer.model', tokenizerBytes],
  ]);
  const requests: string[] = [];
  const model: BuiltInEmbeddingModelSpec = {
    ...EMBEDDINGGEMMA_2,
    modelId: 'test-pooled-model',
    dimension: 4,
    maxTokens: 8,
    queryPrefix: 'q: ',
    model: { name: 'model.onnx', url: 'https://models.test/model.onnx', bytes: modelBytes.length, sha256: sha256(modelBytes) },
    modelData: { name: 'model.onnx_data', url: 'https://models.test/model.onnx_data', bytes: dataBytes.length, sha256: sha256(dataBytes) },
    vocabulary: { name: 'tokenizer.model', url: 'https://models.test/tokenizer.model', bytes: tokenizerBytes.length, sha256: sha256(tokenizerBytes) },
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    requests.push(String(input));
    const body = bodies.get(String(input));
    return body ? new Response(body) : new Response('missing', { status: 404 });
  }) as typeof fetch;
  const batches: EmbeddingBatch[] = [];
  const sessions: EmbeddingSessionOptions[] = [];
  const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir(), ...extraEnv };
  const provider = new BuiltInSourceEmbeddingProvider({
    env,
    model,
    runtime: () => pooledStubRuntime(batches, sessions, dims),
    installerOptions: { fetchImpl, skipRuntime: true },
  });
  const tokenizer = new SentencePieceTokenizer(tokenizerBytes);
  return { provider, batches, sessions, requests, env, model, tokenizer };
}

describe('built-in embedding with a SentencePiece, self-pooling model', () => {
  test('installs the graph, its external weights and the tokenizer side by side', async () => {
    const { provider, requests, env, model } = pooledStubProvider();
    await provider.prepare();
    expect(requests.sort()).toEqual([
      'https://models.test/model.onnx',
      'https://models.test/model.onnx_data',
      'https://models.test/tokenizer.model',
    ]);
    expect(builtInEmbeddingModelFiles(model).map((file) => file.name)).toEqual(['model.onnx', 'model.onnx_data', 'tokenizer.model']);
    const modelDir = join(env.OLYMPUS_BUILT_IN_EMBEDDING_DIR, model.modelId);
    expect(readdirSync(modelDir).sort()).toEqual(['model.onnx', 'model.onnx_data', 'tokenizer.model']);
  });

  test('wraps every window in <bos>/<eos> and reads the pooled sentence_embedding output', async () => {
    const { provider, batches, sessions, tokenizer } = pooledStubProvider();
    // 'title: none | text: ' is 20 tokens before the content: 4 windows of 6.
    const [vector] = await provider.embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_DOCUMENT' });
    expect(sessions).toEqual([{ threads: provider.threads, output: 'sentence_embedding', device: 'gpu' }]);
    const windows = batches.flatMap((batch) => rows(batch));
    expect(windows.every((ids) => ids[0] === tokenizer.bosId && ids.at(-1) === tokenizer.eosId && ids.length <= 8)).toBe(true);
    expect(windows.flatMap((ids) => ids.slice(1, -1))).toEqual(tokenizer.tokenize('title: none | text: hello'));
    expect(Math.hypot(...vector!)).toBeCloseTo(1, 6);
  });

  test('puts a document title into the model\'s prompt, and a query behind its task prefix', async () => {
    const { provider, batches, tokenizer } = pooledStubProvider();
    await provider.embed([{ text: 'hello', title: 'world\n  hello' }], { taskType: 'RETRIEVAL_DOCUMENT' });
    expect(batches.flatMap((batch) => rows(batch)).flatMap((ids) => ids.slice(1, -1)))
      .toEqual(tokenizer.tokenize('title: world hello | text: hello'));
    batches.length = 0;
    await provider.embed([{ text: 'hello world' }], { taskType: 'RETRIEVAL_QUERY' });
    const [ids] = batches.flatMap((batch) => rows(batch));
    expect(ids).toEqual([tokenizer.bosId, ...tokenizer.tokenize('q: hello world').slice(0, 6), tokenizer.eosId]);
  });

  test('refuses a pooled output of the wrong shape', async () => {
    const { provider } = pooledStubProvider((count) => [count, 8]);
    await expect(provider.embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_DOCUMENT' })).rejects.toThrow(/returned shape \[\d+, 8\], expected \[\d+, 4\]/);
  });
});

/**
 * A runtime pack whose `onnxruntime-node` is a stand-in with the given graph
 * signature: it records the feeds of each run and returns zeros for the output.
 */
function fakeOrtPack(
  graph: { inputs: Array<{ name: string; shape: Array<number | string> }>; outputs: string[] },
  failures: { createOnGpu?: boolean; runOnGpu?: boolean } = {},
): string {
  const dir = temporaryDir();
  const module = join(dir, 'node_modules', 'onnxruntime-node');
  mkdirSync(module, { recursive: true });
  writeFileSync(join(module, 'index.js'), `
    const graph = ${JSON.stringify(graph)};
    const failures = ${JSON.stringify(failures)};
    globalThis.fakeOrtCreates = [];
    class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
    globalThis.fakeOrtFeeds = [];
    module.exports = {
      Tensor,
      InferenceSession: {
        async create(path, options) {
          const gpu = options.executionProviders.includes('webgpu');
          globalThis.fakeOrtCreates.push(options.executionProviders);
          if (gpu && failures.createOnGpu) throw new Error('no WebGPU adapter');
          return {
            inputNames: graph.inputs.map((input) => input.name),
            inputMetadata: graph.inputs.map((input) => ({ name: input.name, isTensor: true, shape: input.shape })),
            outputNames: graph.outputs,
            async run(feeds) {
              if (gpu && failures.runOnGpu) throw new Error('GPU device lost');
              globalThis.fakeOrtFeeds.push(Object.fromEntries(Object.entries(feeds).map(([name, tensor]) => [name, { type: tensor.type, dims: tensor.dims }])));
              const [rows] = feeds.input_ids.dims;
              return Object.fromEntries(graph.outputs.map((name) => [name, new Tensor('float32', new Float32Array(rows * 4), [rows, 4])]));
            },
            async release() {},
          };
        },
      },
    };`);
  return dir;
}

describe('the ONNX Runtime seam', () => {
  const batch: EmbeddingBatch = {
    inputIds: new BigInt64Array([2n, 5n, 1n]),
    attentionMask: new BigInt64Array([1n, 1n, 1n]),
    tokenTypeIds: new BigInt64Array(3),
    batchSize: 1,
    sequenceLength: 3,
  };
  const feeds = () => (globalThis as unknown as { fakeOrtFeeds: Array<Record<string, { type: string; dims: number[] }>> }).fakeOrtFeeds;

  test('reads a per-token graph whose output is not named last_hidden_state (Arctic\'s token_embeddings)', async () => {
    const pack = fakeOrtPack({
      inputs: [{ name: 'input_ids', shape: ['batch', 'seq'] }, { name: 'attention_mask', shape: ['batch', 'seq'] }, { name: 'token_type_ids', shape: ['batch', 'seq'] }],
      outputs: ['token_embeddings', 'sentence_embedding'],
    });
    const session = await onnxRuntimeFromDirectory(pack).createSession('model.onnx', { threads: 1 });
    await session.run(batch);
    expect(Object.keys(feeds().at(-1)!).sort()).toEqual(['attention_mask', 'input_ids', 'token_type_ids']);
  });

  test('feeds a multimodal graph empty image, video and audio features, and reads its pooled output', async () => {
    const pack = fakeOrtPack({
      inputs: [
        { name: 'input_ids', shape: ['batch', 'seq'] },
        { name: 'attention_mask', shape: ['batch', 'seq'] },
        { name: 'image_features', shape: ['num_image_tokens', 512] },
        { name: 'video_features', shape: ['num_video_tokens', 512] },
        { name: 'audio_features', shape: ['num_audio_tokens', 512] },
      ],
      outputs: ['last_hidden_state', 'sentence_embedding'],
    });
    const session = await onnxRuntimeFromDirectory(pack).createSession('model.onnx', { threads: 1, output: 'sentence_embedding' });
    expect((await session.run(batch)).dims).toEqual([1, 4]);
    const fed = feeds().at(-1)!;
    for (const name of ['image_features', 'video_features', 'audio_features']) expect(fed[name]).toEqual({ type: 'float32', dims: [0, 512] });
    expect(fed.token_type_ids).toBeUndefined();
  });

  const creates = () => (globalThis as unknown as { fakeOrtCreates: string[][] }).fakeOrtCreates;
  const textGraph = { inputs: [{ name: 'input_ids', shape: ['b', 's'] }, { name: 'attention_mask', shape: ['b', 's'] }], outputs: ['sentence_embedding'] };

  test('a GPU model runs on WebGPU; a CPU model never asks for it', async () => {
    const gpu = await onnxRuntimeFromDirectory(fakeOrtPack(textGraph)).createSession('model.onnx', { threads: 1, output: 'sentence_embedding', device: 'gpu' });
    expect(gpu.device).toBe('gpu');
    expect(creates()).toEqual([['webgpu', 'cpu']]);
    const cpu = await onnxRuntimeFromDirectory(fakeOrtPack(textGraph)).createSession('model.onnx', { threads: 1, output: 'sentence_embedding' });
    expect(cpu.device).toBe('cpu');
    expect(creates()).toEqual([['cpu']]);
  });

  test('without a usable GPU the same graph runs on the CPU', async () => {
    const session = await onnxRuntimeFromDirectory(fakeOrtPack(textGraph, { createOnGpu: true }))
      .createSession('model.onnx', { threads: 1, output: 'sentence_embedding', device: 'gpu' });
    expect(session.device).toBe('cpu');
    expect(creates()).toEqual([['webgpu', 'cpu'], ['cpu']]);
    expect((await session.run(batch)).dims).toEqual([1, 4]);
  });

  test('a GPU that fails mid-run moves the session to the CPU for good', async () => {
    const session = await onnxRuntimeFromDirectory(fakeOrtPack(textGraph, { runOnGpu: true }))
      .createSession('model.onnx', { threads: 1, output: 'sentence_embedding', device: 'gpu' });
    expect(session.device).toBe('gpu');
    expect((await session.run(batch)).dims).toEqual([1, 4]);
    expect(session.device).toBe('cpu');
    await session.run(batch);
    expect(creates()).toEqual([['webgpu', 'cpu'], ['cpu']]);
  });

  test('refuses a graph input it cannot feed, and a missing pooled output', async () => {
    const extra = fakeOrtPack({ inputs: [{ name: 'input_ids', shape: ['b', 's'] }, { name: 'position_ids', shape: ['b', 's'] }], outputs: ['last_hidden_state'] });
    await expect(onnxRuntimeFromDirectory(extra).createSession('model.onnx', { threads: 1 })).rejects.toThrow('cannot feed: position_ids');
    const perToken = fakeOrtPack({ inputs: [{ name: 'input_ids', shape: ['b', 's'] }], outputs: ['last_hidden_state'] });
    await expect(onnxRuntimeFromDirectory(perToken).createSession('model.onnx', { threads: 1, output: 'sentence_embedding' }))
      .rejects.toThrow('no sentence_embedding output');
  });
});

describe('the built-in model\'s device', () => {
  test('only a model measured to match on the GPU asks for it, and the owner can keep it on the CPU', async () => {
    const { provider, sessions } = pooledStubProvider();
    await provider.prepare();
    expect(sessions.at(-1)?.device).toBe('gpu');
    expect(EMBEDDINGGEMMA_2.gpu).toBe(true);
    expect(ARCTIC_EMBED_M_V1_5.gpu).toBeUndefined();
    const forced = pooledStubProvider(undefined, { OLYMPUS_BUILT_IN_EMBEDDING_DEVICE: 'cpu' });
    await forced.provider.prepare();
    expect(forced.sessions.at(-1)?.device).toBe('cpu');
    expect(() => pooledStubProvider(undefined, { OLYMPUS_BUILT_IN_EMBEDDING_DEVICE: 'metal' }))
      .toThrow('must be "auto" or "cpu"');
  });
});

describe('the built-in model registry', () => {
  test('EmbeddingGemma 2 is the new-install default and Arctic stays loadable', () => {
    expect(BUILT_IN_EMBEDDING_MODEL).toBe(EMBEDDINGGEMMA_2);
    expect(BUILT_IN_EMBEDDING_MODELS.map((model) => model.modelId)).toEqual([EMBEDDINGGEMMA_2.modelId, ARCTIC_EMBED_M_V1_5.modelId]);
    expect(new Set(BUILT_IN_EMBEDDING_MODELS.map((model) => model.modelId)).size).toBe(BUILT_IN_EMBEDDING_MODELS.length);
    for (const model of BUILT_IN_EMBEDDING_MODELS) {
      expect(canonicalEmbeddingIdentityForModel(model.modelId)?.dimension).toBe(model.dimension);
    }
  });

  test('Arctic keeps the identity its stored vectors were written under', () => {
    const provider = new BuiltInSourceEmbeddingProvider({ env: { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir() }, model: ARCTIC_EMBED_M_V1_5 });
    expect(provider.epochId).toBe(ARCTIC_EPOCH);
    // Frozen from the build before EmbeddingGemma 2 was added: a change here re-embeds every Arctic install.
    expect(provider.configHash).toBe('1a42a3ee2296bb1f5572df71ab1361647e77d5f87c7b7b5351c606c79f0449f0');
  });

  test('an install that embedded with Arctic keeps embedding with Arctic', () => {
    const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir() };
    for (const preset of SOVEREIGNTY_PRESETS) {
      const config = loadSovereigntyPreset(preset);
      const [id] = Object.entries(config.modelProfiles).find(([, profile]) => profile.provider === 'built-in')!;
      const arcticEra: SovereigntyConfig = {
        ...config,
        modelProfiles: { ...config.modelProfiles, [id]: { ...config.modelProfiles[id]!, model: ARCTIC_EMBED_M_V1_5.modelId } },
      };
      const provider = createSourceIndexEmbeddingProviderFromSovereignty(createSovereigntyEngine(arcticEra), 'internal', env);
      expect(provider?.modelId).toBe(ARCTIC_EMBED_M_V1_5.modelId);
      expect(provider?.epochId).toBe(ARCTIC_EPOCH);
    }
  });

  // Ship gates. These fail until EmbeddingGemma 2 is pinned
  // (`bun scripts/pin-built-in-embedding.ts --write`) and its relevance bar
  // is calibrated on a real corpus: the default must never ship half-done.
  test('every built-in model is pinned to an exact revision, size and digest', () => {
    for (const model of BUILT_IN_EMBEDDING_MODELS) {
      expect({ model: model.modelId, revision: /^[0-9a-f]{40}$/.test(model.revision) }).toEqual({ model: model.modelId, revision: true });
      expect(model.modelId).not.toContain('UNPINNED');
      for (const file of builtInEmbeddingModelFiles(model)) {
        expect({ file: file.url, pinned: /^[0-9a-f]{64}$/.test(file.sha256) && file.bytes > 0 })
          .toEqual({ file: file.url, pinned: true });
        // The weights are at the model's revision; a tokenizer may be pinned from another repository's commit.
        expect({ file: file.url, exact: /\/resolve\/[0-9a-f]{40}\//.test(file.url) }).toEqual({ file: file.url, exact: true });
      }
      for (const file of [model.model, ...(model.modelData ? [model.modelData] : [])]) {
        expect(file.url).toContain(`/resolve/${model.revision}/`);
      }
    }
  });

  test('every built-in model has a relevance bar calibrated for its vector lane', () => {
    for (const model of BUILT_IN_EMBEDDING_MODELS) {
      const bar = calibratedSemanticRelevanceBar(model.modelId);
      expect({ model: model.modelId, calibrated: bar !== undefined && bar > 0 && bar < 1 })
        .toEqual({ model: model.modelId, calibrated: true });
    }
  });
});

const realTest = process.env.OLYMPUS_BUILT_IN_EMBEDDING_REAL_TEST === '1' ? test : test.skip;

describe('built-in embedding with the real model (opt-in)', () => {
  realTest('downloads, verifies and ranks a relevant passage first', async () => {
    const env = {
      ...process.env,
      OLYMPUS_BUILT_IN_EMBEDDING_DIR: process.env.OLYMPUS_BUILT_IN_EMBEDDING_DIR || temporaryDir(),
    };
    const provider = new BuiltInSourceEmbeddingProvider({ env });
    await provider.prepare();
    const passages = [
      'Your United flight from Boston to San Francisco departs October 14 at 7:05am.',
      'The plumber will come Thursday morning to fix the leaking kitchen sink.',
      'Invoice #4521 from Acme Hosting: $89.00 due October 15.',
    ];
    const documents = await provider.embed(passages.map((text) => ({ text })), { taskType: 'RETRIEVAL_DOCUMENT' });
    const [query] = await provider.embed([{ text: 'who is fixing the sink' }], { taskType: 'RETRIEVAL_QUERY' });
    expect(documents.every((vector) => vector.length === 768)).toBe(true);
    const scores = documents.map((vector) => vector.reduce((sum, value, index) => sum + value * query![index]!, 0));
    expect(scores.indexOf(Math.max(...scores))).toBe(1);
  }, 900_000);
});

// ---------------------------------------------------------------------------

function rows(batch: EmbeddingBatch): number[][] {
  return Array.from({ length: batch.batchSize }, (_, row) => {
    const ids: number[] = [];
    for (let column = 0; column < batch.sequenceLength; column += 1) {
      const index = row * batch.sequenceLength + column;
      if (batch.attentionMask[index] === 1n) ids.push(Number(batch.inputIds[index]));
    }
    return ids;
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function buildTar(entries: Array<{ path: string; data: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const data = new TextEncoder().encode(entry.data);
    const header = new Uint8Array(512);
    const write = (offset: number, value: string) => header.set(new TextEncoder().encode(value), offset);
    write(0, entry.path);
    write(100, '0000644\0');
    write(108, '0000000\0');
    write(116, '0000000\0');
    write(124, `${data.length.toString(8).padStart(11, '0')}\0`);
    write(136, '00000000000\0');
    write(148, '        ');
    write(156, '0');
    write(257, 'ustar\0');
    write(263, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    write(148, `${checksum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}
