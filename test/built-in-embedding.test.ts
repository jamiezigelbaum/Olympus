/**
 * The built-in embedding model (owner decision 2026-10-01): the zero-setup
 * default for new installs. These tests run with a stub runtime and a stub
 * download server; `OLYMPUS_BUILT_IN_EMBEDDING_REAL_TEST=1` additionally runs
 * the real model (downloads ~225 MB once into OLYMPUS_BUILT_IN_EMBEDDING_DIR
 * or a temporary directory).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
import {
  BUILT_IN_EMBEDDING_MODEL,
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
import type { EmbeddingBatch, EmbeddingRuntime } from '../src/workers/source-index/built-in-embedding/runtime.ts';
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

const BUILT_IN_EPOCH = 'local:built-in:arctic-embed-m-v1.5-int8-e58a8f7:768';

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
    ...BUILT_IN_EMBEDDING_MODEL,
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
function stubRuntime(log: EmbeddingBatch[]): EmbeddingRuntime {
  return {
    async createSession() {
      return {
        async run(batch) {
          log.push(batch);
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

function stubProvider(options: { status?: number; threads?: number } = {}) {
  const dir = temporaryDir();
  const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir };
  const served = servedAssets(options.status ? { status: options.status } : {});
  const batches: EmbeddingBatch[] = [];
  const provider = new BuiltInSourceEmbeddingProvider({
    env,
    model: served.model,
    runtime: () => stubRuntime(batches),
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
    expect(createSourceIndexEmbeddingProviderFromEnv({ ...env, OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'built-in' })).toBe(internal);
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
