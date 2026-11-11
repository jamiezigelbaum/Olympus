import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  builtInRerankerFromEnv,
  prepareBuiltInRerankerFromEnv,
  SOURCE_RERANKER_ENV,
  SOURCE_RERANKER_MODEL_DIR_ENV,
  SOURCE_RERANKER_THREADS_ENV,
  SOURCE_RERANKER_POOL_ENV,
} from '../src/workers/source-index/built-in-reranker.ts';
import { BUILT_IN_RERANKER_MODELS, MS_MARCO_MINILM_L6_V2, MMARCO_MMINILMV2_L12_H384_V1 } from '../src/workers/source-index/built-in-reranker-manifest.ts';
import type { EmbeddingBatch, EmbeddingRuntime, EmbeddingSession } from '../src/workers/source-index/built-in-embedding/runtime.ts';

const temporaryDirs: string[] = [];
afterEach(() => { for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function modelDirectory(tokenizer: 'unigram' | 'bpe' | 'wordpiece' = 'unigram') {
  const path = mkdtempSync(join(tmpdir(), 'olympus-reranker-'));
  temporaryDirs.push(path);
  writeFileSync(join(path, 'model.onnx'), 'stub model');
  if (tokenizer === 'wordpiece') writeFileSync(join(path, 'vocab.txt'), '[PAD]\n[UNK]\n[CLS]\n[SEP]\ninvoice\nhello');
  else writeFileSync(join(path, 'tokenizer.json'), readFileSync(join(import.meta.dir, 'fixtures/reranker', `${tokenizer}.json`)));
  return path;
}

const environment = (path: string) => ({
  [SOURCE_RERANKER_ENV]: 'built-in', [SOURCE_RERANKER_MODEL_DIR_ENV]: path,
  [SOURCE_RERANKER_THREADS_ENV]: '2', [SOURCE_RERANKER_POOL_ENV]: '24',
});
const request = () => ({ query: 'invoice', passages: ['hello', ''], signal: new AbortController().signal });

describe('built-in reranker model loading', () => {
  test.each(['unigram', 'bpe'] as const)('loads %s tokenizer.json without vocab.txt and pads XLM-R pairs', async (kind) => {
    const path = modelDirectory(kind);
    const batches: EmbeddingBatch[] = [];
    const runtime: EmbeddingRuntime = { createSession: async (file, options) => {
      expect(file).toBe(join(path, 'model.onnx'));
      expect(options).toEqual({ threads: 2 });
      return { run: async (batch) => {
        batches.push(batch);
        return { data: new Float32Array(batch.batchSize).fill(7), dims: [batch.batchSize, 1] };
      } };
    } };
    const reranker = await prepareBuiltInRerankerFromEnv({ env: environment(path), runtime });
    expect(reranker?.poolSize).toBe(24);
    expect(await reranker!.score(request())).toEqual([7, 7]);
    const batch = batches[0]!;
    const size = batch.sequenceLength;
    expect([...batch.inputIds.slice(0, 1)]).toEqual([0n]);
    expect([batch.inputIds[2], batch.inputIds[3], batch.inputIds[size - 1]]).toEqual([2n, 2n, 2n]);
    // The empty passage has one fewer content token: the final cell is pad,
    // not </s>, and is masked out. XLM-R has no BERT segment-id boundary.
    expect(batch.inputIds[2 * size - 1]).toBe(1n);
    expect(batch.attentionMask[2 * size - 1]).toBe(0n);
    expect([...batch.tokenTypeIds].every((id) => id === 0n)).toBe(true);
  });

  test('prefers the unchanged WordPiece path when both tokenizer files exist', async () => {
    const path = modelDirectory('wordpiece');
    writeFileSync(join(path, 'tokenizer.json'), 'invalid JSON: must not be read');
    let batch: EmbeddingBatch | undefined;
    const runtime: EmbeddingRuntime = { createSession: async () => ({ run: async (input) => {
      batch = input;
      return { data: new Float32Array(input.batchSize), dims: [input.batchSize, 1] };
    } }) };
    await (await prepareBuiltInRerankerFromEnv({ env: environment(path), runtime }))!.score({ ...request(), passages: ['hello'] });
    expect([...batch!.inputIds]).toEqual([2n, 4n, 3n, 5n, 3n]);
    expect([...batch!.tokenTypeIds]).toEqual([0n, 0n, 0n, 1n, 1n]);
  });

  test('startup waits for the session, does no inference, and the first question reuses it', async () => {
    const path = modelDirectory();
    let release!: (session: EmbeddingSession) => void;
    const loading = new Promise<EmbeddingSession>((resolve) => { release = resolve; });
    let loads = 0;
    let runs = 0;
    let ready = false;
    const starting = prepareBuiltInRerankerFromEnv({ env: environment(path), runtime: {
      createSession: () => { loads += 1; return loading; },
    } });
    void starting.then(() => { ready = true; });
    await Promise.resolve();
    expect(loads).toBe(1);
    expect(ready).toBe(false);
    release({ run: async (batch) => {
      runs += 1;
      return { data: new Float32Array(batch.batchSize), dims: [batch.batchSize, 1] };
    } });
    const reranker = (await starting)!;
    expect(ready).toBe(true);
    expect(runs).toBe(0);
    await Promise.all([reranker.prepare(), reranker.prepare()]);
    await reranker.score(request());
    expect(loads).toBe(1);
    expect(runs).toBe(1);
  });

  test('a failed startup load warns without blocking the engine and retries on scoring', async () => {
    let loads = 0;
    const warnings: string[] = [];
    const reranker = (await prepareBuiltInRerankerFromEnv({ env: environment(modelDirectory()), runtime: {
      createSession: async () => {
        if (++loads === 1) throw new Error('load failure');
        return { run: async (batch) => ({ data: new Float32Array(batch.batchSize), dims: [batch.batchSize, 1] }) };
      },
    } }, (message) => warnings.push(message)))!;
    expect(warnings).toHaveLength(1);
    expect(await reranker.score(request())).toEqual([0, 0]);
    expect(loads).toBe(2);
  });

  test('stays disabled by default, and missing model/tokenizer files never load a runtime', async () => {
    const runtime: EmbeddingRuntime = { createSession: async () => { throw new Error('must not load'); } };
    expect(await prepareBuiltInRerankerFromEnv({ env: {}, runtime })).toBeUndefined();
    expect(builtInRerankerFromEnv({ env: environment('relative/path'), runtime })).toBeUndefined();
    const path = modelDirectory();
    rmSync(join(path, 'tokenizer.json'));
    expect(builtInRerankerFromEnv({ env: environment(path), runtime })).toBeUndefined();
    writeFileSync(join(path, 'vocab.txt'), '[PAD]\n[UNK]\n[CLS]\n[SEP]');
    rmSync(join(path, 'model.onnx'));
    expect(builtInRerankerFromEnv({ env: environment(path), runtime })).toBeUndefined();
  });
});

describe('candidate pins (#921)', () => {
  test('offers both candidates without selecting a default', () => {
    expect(BUILT_IN_RERANKER_MODELS).toEqual([MS_MARCO_MINILM_L6_V2, MMARCO_MMINILMV2_L12_H384_V1]);
    expect(MS_MARCO_MINILM_L6_V2.revision).toBe('233902d25c440f23af6f7d6e94d2946bac0bee0a');
    expect(MS_MARCO_MINILM_L6_V2.model).toMatchObject({ name: 'model.onnx', bytes: 91_011_230, sha256: '5d3e70fd0c9ff14b9b5169a51e957b7a9c74897afd0a35ce4bd318150c1d4d4a' });
    expect(MS_MARCO_MINILM_L6_V2.tokenizer).toMatchObject({ name: 'vocab.txt', bytes: 231_508, sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' });
    const multilingual = MMARCO_MMINILMV2_L12_H384_V1;
    expect(multilingual.revision).toBe('1427fd652930e4ba29e8149678df786c240d8825');
    expect(multilingual.model).toEqual({
      name: 'model.onnx', bytes: 118_620_017,
      sha256: '1825907d6c1a9001ff78124780bbde20a614a8c3df3b63409cf3c72c6fe5c8b4',
      url: `https://huggingface.co/${multilingual.repository}/resolve/${multilingual.revision}/onnx/model_qint8_arm64.onnx`,
    });
    expect(multilingual.tokenizer).toEqual({
      name: 'tokenizer.json', bytes: 17_082_660,
      sha256: '62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626',
      url: `https://huggingface.co/${multilingual.repository}/resolve/${multilingual.revision}/tokenizer.json`,
    });
  });
});
