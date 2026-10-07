/**
 * The built-in embedding model: the zero-setup default for new installs
 * (Arctic Embed M v1.5 from 2026-10-01, EmbeddingGemma 2 from 2026-10-06).
 * These tests run with a stub runtime and a stub download server;
 * `OLYMPUS_BUILT_IN_EMBEDDING_REAL_TEST=1` additionally runs the real default
 * model (downloads it once into OLYMPUS_BUILT_IN_EMBEDDING_DIR or a temporary
 * directory; EmbeddingGemma 2 runs through LiteRT-LM and needs Bun).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { loadSovereigntyPreset, SOVEREIGNTY_PRESETS, validateSovereigntyConfig, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import {
  BuiltInEmbeddingInstallError,
  builtInEmbeddingPaths,
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
  LITERT_RUNTIME_PACK,
  ONNX_RUNTIME_PACK,
  type BuiltInEmbeddingModelSpec,
  type LiteRtRuntimePackSpec,
  type OnnxRuntimePackSpec,
} from '../src/workers/source-index/built-in-embedding/manifest.ts';
import {
  BuiltInEmbeddingNotReadyError,
  BuiltInSourceEmbeddingProvider,
  builtInEmbeddingAttention,
  builtInEmbeddingDashboardState,
  sharedBuiltInSourceEmbeddingProvider,
} from '../src/workers/source-index/built-in-embedding/provider.ts';
import { startLiteRtEmbedder, type LiteRtEmbedder, type LiteRtEmbedderOptions } from '../src/workers/source-index/built-in-embedding/litert-runtime.ts';
import type { EmbeddingBatch, EmbeddingRuntime } from '../src/workers/source-index/built-in-embedding/runtime.ts';
import { readZipEntry } from '../src/workers/source-index/built-in-embedding/zip.ts';
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

const BUILT_IN_EPOCH = 'local:built-in:embeddinggemma-2-litert-24d962e:768';
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

    expect(readFileSync(installed.vocabularyPath!, 'utf8')).toBe(VOCAB);
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
    await Bun.write(installed.vocabularyPath!, VOCAB.replace('hello', 'HELLO'));
    const tampered = await installBuiltInEmbedding({
      env, model: { ...served.model, modelId: served.model.modelId }, skipRuntime: true, fetchImpl: served.fetchImpl,
    }).catch((caught: unknown) => caught);
    // This process already verified the file once; a fresh process re-hashes.
    // Either the cache short-circuits or the mismatch is caught: never a silent load of a different vocabulary.
    if (tampered instanceof BuiltInEmbeddingInstallError) {
      expect(tampered.reason).toBe('checksum_mismatch');
      expect(existsSync(installed.vocabularyPath!)).toBe(false);
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
// LiteRT-LM (EmbeddingGemma 2)

describe('ZIP reader', () => {
  test('reads a stored or deflated entry and reports a missing one', () => {
    const archive = buildZip([
      { name: 'litert_lm/__init__.py', data: 'stored', deflate: false },
      { name: 'litert_lm/liblitert-lm.dylib', data: 'native library '.repeat(200), deflate: true },
    ]);
    expect(new TextDecoder().decode(readZipEntry(archive, 'litert_lm/liblitert-lm.dylib'))).toBe('native library '.repeat(200));
    expect(new TextDecoder().decode(readZipEntry(archive, 'litert_lm/__init__.py'))).toBe('stored');
    expect(readZipEntry(archive, 'litert_lm/other.so')).toBeUndefined();
    expect(() => readZipEntry(new Uint8Array(64), 'x')).toThrow('Not a ZIP archive');
    // The directory still names the entry, but its bytes are gone.
    const truncated = new Uint8Array([...archive.subarray(0, 40), ...archive.subarray(archive.length - 200)]);
    expect(() => readZipEntry(truncated, 'litert_lm/liblitert-lm.dylib')).toThrow();
  });
});

const PLATFORM = `${process.platform}-${process.arch}`;

function servedLiteRt(options: { corruptWheel?: boolean } = {}) {
  const modelBytes = new TextEncoder().encode('fake litertlm bundle '.repeat(500));
  const wheel = buildZip([{ name: 'litert_lm/liblitert-lm.dylib', data: 'native library', deflate: true }]);
  const served = options.corruptWheel ? new Uint8Array(wheel.length).fill(7) : wheel;
  const requests: string[] = [];
  const model: BuiltInEmbeddingModelSpec = {
    ...EMBEDDINGGEMMA_2,
    modelId: 'test-litert-model',
    dimension: 4,
    model: { name: 'model.litertlm', url: 'https://models.test/model.litertlm', bytes: modelBytes.length, sha256: sha256(modelBytes) },
  };
  const pack: LiteRtRuntimePackSpec = {
    version: LITERT_RUNTIME_PACK.version,
    platforms: { [PLATFORM]: { name: 'litert.whl', url: 'https://wheels.test/litert.whl', bytes: wheel.length, sha256: sha256(wheel), library: 'litert_lm/liblitert-lm.dylib' } },
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    requests.push(String(input));
    const body = String(input).endsWith('.litertlm') ? modelBytes : String(input).endsWith('.whl') ? served : undefined;
    return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 });
  }) as typeof fetch;
  return { model, pack, fetchImpl, requests };
}

describe('built-in embedding installer with a LiteRT model', () => {
  test('downloads the model and takes only the library out of the pinned wheel', async () => {
    const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir() };
    const served = servedLiteRt();
    const installed = await installBuiltInEmbedding({ env, model: served.model, liteRtRuntime: served.pack, fetchImpl: served.fetchImpl });
    expect(installed.vocabularyPath).toBeUndefined();
    expect(readFileSync(installed.libraryPath!, 'utf8')).toBe('native library');
    expect(readdirSync(installed.runtimeDir).sort()).toEqual(['liblitert-lm.dylib', 'olympus-runtime.json']);
    expect(installed.runtimeDir).toBe(builtInEmbeddingPaths(env, served.model).runtimeDir);
    expect(served.requests.sort()).toEqual(['https://models.test/model.litertlm', 'https://wheels.test/litert.whl']);
    // Installed once: a second call downloads nothing.
    await installBuiltInEmbedding({ env, model: served.model, liteRtRuntime: served.pack, fetchImpl: served.fetchImpl });
    expect(served.requests).toHaveLength(2);
  });

  test('a library changed on disk after unpacking is unpacked again from the pinned wheel', async () => {
    const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir() };
    const served = servedLiteRt();
    const installed = await installBuiltInEmbedding({ env, model: served.model, liteRtRuntime: served.pack, fetchImpl: served.fetchImpl });
    writeFileSync(installed.libraryPath!, 'tampered');
    await installBuiltInEmbedding({ env, model: served.model, liteRtRuntime: served.pack, fetchImpl: served.fetchImpl });
    expect(readFileSync(installed.libraryPath!, 'utf8')).toBe('native library');
    expect(served.requests.filter((url) => url.endsWith('.whl'))).toHaveLength(2);
  });

  test('a wheel that does not match its pin installs nothing; a platform without a wheel is unsupported', async () => {
    const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir() };
    const served = servedLiteRt({ corruptWheel: true });
    const failed = await installBuiltInEmbedding({ env, model: served.model, liteRtRuntime: served.pack, fetchImpl: served.fetchImpl })
      .catch((caught: unknown) => caught);
    expect((failed as BuiltInEmbeddingInstallError).reason).toBe('checksum_mismatch');
    expect(existsSync(builtInEmbeddingPaths(env, served.model).runtimeDir)).toBe(false);
    const unsupported = await installBuiltInEmbedding({
      env, model: served.model, liteRtRuntime: { ...served.pack, platforms: {} }, fetchImpl: served.fetchImpl,
    }).catch((caught: unknown) => caught);
    expect((unsupported as BuiltInEmbeddingInstallError).reason).toBe('unsupported_platform');
  });
});

/** A stand-in LiteRT helper: each prompt becomes `[length, first char code, batch size, 1]`. */
function stubLiteRt(log: { batches: string[][]; options: LiteRtEmbedderOptions[] }, dimension = 4) {
  return async (options: LiteRtEmbedderOptions): Promise<LiteRtEmbedder> => {
    log.options.push(options);
    return {
      device: options.device === 'cpu' ? 'cpu' : 'gpu',
      async embed(texts) {
        log.batches.push([...texts]);
        return texts.map((text) => Float32Array.from({ length: dimension }, (_, index) => [text.length, text.charCodeAt(0), texts.length, 1][index] ?? 0));
      },
      async release() {},
    };
  };
}

function liteRtProvider(extraEnv: Record<string, string> = {}, dimension = 4) {
  const served = servedLiteRt();
  const log = { batches: [] as string[][], options: [] as LiteRtEmbedderOptions[] };
  const provider = new BuiltInSourceEmbeddingProvider({
    env: { OLYMPUS_BUILT_IN_EMBEDDING_DIR: temporaryDir(), ...extraEnv },
    model: served.model,
    liteRt: stubLiteRt(log, dimension),
    installerOptions: { fetchImpl: served.fetchImpl, liteRtRuntime: served.pack },
  });
  return { provider, log };
}

describe('built-in embedding with a LiteRT model', () => {
  test('frames documents and questions in the model\'s prompts and sends them in small batches', async () => {
    const { provider, log } = liteRtProvider();
    const documents = Array.from({ length: 11 }, (_, index) => ({ text: `note ${index}`, ...(index === 0 ? { title: 'Lab\n  results' } : {}) }));
    const vectors = await provider.embed(documents, { taskType: 'RETRIEVAL_DOCUMENT' });
    expect(vectors).toHaveLength(11);
    expect(vectors.every((vector) => Math.abs(Math.hypot(...vector) - 1) < 1e-6)).toBe(true);
    expect(log.batches.map((batch) => batch.length)).toEqual([8, 3]);
    expect(log.batches[0]![0]).toBe('title: Lab results | text: note 0');
    expect(log.batches[0]![1]).toBe('title: none | text: note 1');
    await provider.embed([{ text: 'my liver numbers' }], { taskType: 'RETRIEVAL_QUERY' });
    expect(log.batches.at(-1)).toEqual(['task: search result | query: my liver numbers']);
  });

  test('starts the helper with the installed library, a cache beside the model, and the owner\'s device choice', async () => {
    const auto = liteRtProvider();
    await auto.provider.prepare();
    const [options] = auto.log.options;
    expect(options!.library.endsWith('liblitert-lm.dylib')).toBe(true);
    expect(options!.model.endsWith('model.litertlm')).toBe(true);
    expect(options!.cacheDir).toBe(join(options!.model, '..', 'cache'));
    expect(options!.device).toBe('auto');
    expect(options!.maxInputTokens).toBe(EMBEDDINGGEMMA_2.maxTokens);
    const cpu = liteRtProvider({ OLYMPUS_BUILT_IN_EMBEDDING_DEVICE: 'cpu' });
    await cpu.provider.prepare();
    expect(cpu.log.options[0]!.device).toBe('cpu');
    expect(() => liteRtProvider({ OLYMPUS_BUILT_IN_EMBEDDING_DEVICE: 'metal' })).toThrow('must be "auto" or "cpu"');
  });

  test('a question never waits for a LiteRT start: it falls back and the start begins', async () => {
    const { provider, log } = liteRtProvider();
    await expect(provider.embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_QUERY' })).rejects.toBeInstanceOf(BuiltInEmbeddingNotReadyError);
    await provider.prepare();
    expect(log.options).toHaveLength(1);
    await provider.embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_QUERY' });
    expect(log.batches).toHaveLength(1);
  });

  test('refuses a vector of the wrong size', async () => {
    const { provider } = liteRtProvider({}, 8);
    await expect(provider.embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_DOCUMENT' })).rejects.toThrow('returned 8 values, expected 4');
  });
});

/** A helper script that speaks the LiteRT helper's protocol without LiteRT. */
function fakeHelper(behaviour: 'ok' | 'fatal' | 'crash-first-gpu-batch' | 'native-error-on-gpu' | 'crash-on-gpu-start' | 'close-stdin' | 'hang' | 'ignore-stdin-close'): string {
  const path = join(temporaryDir(), 'fake-helper.js');
  writeFileSync(path, `
    const settings = JSON.parse(process.argv[2]);
    const behaviour = ${JSON.stringify(behaviour)};
    if (behaviour === 'fatal') { console.log(JSON.stringify({ fatal: 'no model here' })); process.exit(1); }
    const device = settings.device === 'auto' ? 'gpu' : 'cpu';
    if (behaviour === 'crash-on-gpu-start' && device === 'gpu') process.exit(139);
    console.log('library chatter that is not JSON');
    console.log(JSON.stringify({ ready: true, device }));
    if (behaviour === 'close-stdin') { process.stdin.destroy(); setInterval(() => {}, 1000); return; }
    const lines = require('node:readline').createInterface({ input: process.stdin });
    if (behaviour === 'ignore-stdin-close') setInterval(() => {}, 1000);
    else lines.on('close', () => process.exit(0));
    lines.on('line', (line) => {
      if (behaviour === 'hang') return;
      const { id, texts } = JSON.parse(line);
      if (behaviour === 'crash-first-gpu-batch' && device === 'gpu') process.exit(3);
      if (behaviour === 'native-error-on-gpu' && device === 'gpu') { console.log(JSON.stringify({ id, error: 'LiteRT-LM could not embed this batch.', native: true })); return; }
      if (texts.includes('bad')) { console.log(JSON.stringify({ id, error: 'Every input must be non-empty text.' })); return; }
      const vectors = new Float32Array(texts.length * 2);
      texts.forEach((text, index) => vectors.set([text.length, device === 'gpu' ? 1 : 2], index * 2));
      console.log(JSON.stringify({ id, dimension: 2, vectors: Buffer.from(vectors.buffer).toString('base64') }));
    });
  `);
  return path;
}

function helperOptions(helperPath: string, extra: Partial<LiteRtEmbedderOptions> = {}): LiteRtEmbedderOptions {
  return { library: '/lib.so', model: '/model.litertlm', cacheDir: '/cache', threads: 1, device: 'auto', maxInputTokens: 2048, bunPath: process.execPath, helperPath, ...extra };
}

describe('the LiteRT helper process', () => {
  test('starts, reports its device, and returns one vector per text', async () => {
    const embedder = await startLiteRtEmbedder(helperOptions(fakeHelper('ok')));
    expect(embedder.device).toBe('gpu');
    const vectors = await embedder.embed(['ab', 'abcd']);
    expect(vectors.map((vector) => Array.from(vector))).toEqual([[2, 1], [4, 1]]);
    await embedder.release();
  });

  test('a helper that cannot open the model fails the start with its reason', async () => {
    await expect(startLiteRtEmbedder(helperOptions(fakeHelper('fatal')))).rejects.toThrow('no model here');
  });

  test('a helper that stops on the GPU fails that batch and comes back on the CPU', async () => {
    const embedder = await startLiteRtEmbedder(helperOptions(fakeHelper('crash-first-gpu-batch')));
    await expect(embedder.embed(['abc'])).rejects.toThrow('stopped');
    const vectors = await embedder.embed(['abc']);
    expect(embedder.device).toBe('cpu');
    expect(Array.from(vectors[0]!)).toEqual([3, 2]);
    await embedder.release();
  });

  test('a native failure replaces the helper (GPU to CPU); a bad request fails only itself', async () => {
    const embedder = await startLiteRtEmbedder(helperOptions(fakeHelper('native-error-on-gpu')));
    await expect(embedder.embed(['abc'])).rejects.toThrow('could not embed');
    expect(Array.from((await embedder.embed(['abc']))[0]!)).toEqual([3, 2]);
    expect(embedder.device).toBe('cpu');
    await expect(embedder.embed(['bad'])).rejects.toThrow('non-empty text');
    expect(Array.from((await embedder.embed(['abcd']))[0]!)).toEqual([4, 2]);
    expect(embedder.device).toBe('cpu');
    await embedder.release();
  });

  test('a helper that dies starting on the GPU is started again on the CPU', async () => {
    const embedder = await startLiteRtEmbedder(helperOptions(fakeHelper('crash-on-gpu-start')));
    expect(embedder.device).toBe('cpu');
    expect(Array.from((await embedder.embed(['abc']))[0]!)).toEqual([3, 2]);
    await embedder.release();
  });

  test('a write to a helper that closed its input fails the batch, not this process', async () => {
    const embedder = await startLiteRtEmbedder(helperOptions(fakeHelper('close-stdin'), { requestTimeoutMs: 1_000 }));
    await Bun.sleep(100);
    // Large enough to need more than one pipe write after the reader is gone:
    // the write fails (EPIPE) or goes unanswered; either way only the batch fails.
    await expect(embedder.embed(['x'.repeat(1_000_000)])).rejects.toThrow(/stopped/);
    await embedder.release();
  });

  test('a batch that never answers is abandoned and the helper replaced', async () => {
    const embedder = await startLiteRtEmbedder(helperOptions(fakeHelper('hang'), { requestTimeoutMs: 200 }));
    await expect(embedder.embed(['abc'])).rejects.toThrow('stopped responding');
    // The next batch starts a new helper (on the CPU, since the stuck one was on the GPU); it hangs too, and is abandoned too.
    await expect(embedder.embed(['abc'])).rejects.toThrow('stopped responding');
    expect(embedder.device).toBe('cpu');
    await embedder.release();
  });

  test('release kills a helper that does not exit when its input closes', async () => {
    const embedder = await startLiteRtEmbedder(helperOptions(fakeHelper('ignore-stdin-close'), { stopTimeoutMs: 100 }));
    const started = Date.now();
    await embedder.release();
    expect(Date.now() - started).toBeLessThan(3_000);
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

  // Ship gates: every model and runtime file pinned, and a relevance bar
  // calibrated on a real corpus. The default must never ship half-done.
  test('every built-in model is pinned to an exact revision, size and digest', () => {
    for (const model of BUILT_IN_EMBEDDING_MODELS) {
      expect({ model: model.modelId, revision: /^[0-9a-f]{40}$/.test(model.revision) }).toEqual({ model: model.modelId, revision: true });
      expect(model.modelId).not.toContain('UNPINNED');
      for (const file of builtInEmbeddingModelFiles(model)) {
        expect({ file: file.url, pinned: /^[0-9a-f]{64}$/.test(file.sha256) && file.bytes > 0 })
          .toEqual({ file: file.url, pinned: true });
        expect(file.url).toContain(`/resolve/${model.revision}/`);
      }
    }
    for (const [platform, wheel] of Object.entries(LITERT_RUNTIME_PACK.platforms)) {
      expect({ platform, pinned: /^[0-9a-f]{64}$/.test(wheel.sha256) && wheel.bytes > 0 && wheel.url.includes(LITERT_RUNTIME_PACK.version) })
        .toEqual({ platform, pinned: true });
    }
    expect(Object.keys(LITERT_RUNTIME_PACK.platforms).sort()).toEqual([...ONNX_RUNTIME_PACK.platforms].sort());
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
    // Longer than the model's 2,048-token window: read in pieces, not refused or cut.
    const [long] = await provider.embed([{ text: 'The plumber fixed the kitchen sink and replaced the faucet. '.repeat(400) }], { taskType: 'RETRIEVAL_DOCUMENT' });
    expect(long!.length).toBe(768);
    expect(long!.reduce((sum, value, index) => sum + value * query![index]!, 0)).toBeGreaterThan(scores[0]!);
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

/** A ZIP archive with stored or deflated entries, as a wheel is built. */
function buildZip(entries: Array<{ name: string; data: string; deflate: boolean }>): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const raw = new TextEncoder().encode(entry.data);
    const body = entry.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(8, entry.deflate ? 8 : 0, true);
    header.setUint32(18, body.length, true);
    header.setUint32(22, raw.length, true);
    header.setUint16(26, name.length, true);
    local.push(new Uint8Array(header.buffer), name, body);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(10, entry.deflate ? 8 : 0, true);
    record.setUint32(20, body.length, true);
    record.setUint32(24, raw.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
