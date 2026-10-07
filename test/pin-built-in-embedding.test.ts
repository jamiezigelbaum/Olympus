import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pinFromTree,
  renderPinBlock,
  replacePinBlock,
  variantOf,
  type HubTreeEntry,
} from '../scripts/pin-built-in-embedding.ts';
import { EMBEDDINGGEMMA_2 } from '../src/workers/source-index/built-in-embedding/manifest.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const sha = (char: string) => char.repeat(64);

const TREE: HubTreeEntry[] = [
  { type: 'directory', path: 'onnx', size: 0, oid: 'd' },
  { type: 'file', path: 'config.json', size: 900, oid: 'a' },
  { type: 'file', path: 'tokenizer.model', size: 4_689_016, oid: 'b', lfs: { oid: sha('b'), size: 4_689_016 } },
  { type: 'file', path: 'onnx/model.onnx', size: 600_000, oid: 'c', lfs: { oid: sha('c'), size: 600_000 } },
  { type: 'file', path: 'onnx/model.onnx_data', size: 1_200_000_000, oid: 'e', lfs: { oid: sha('e'), size: 1_200_000_000 } },
  { type: 'file', path: 'onnx/model_quantized.onnx', size: 310_000_000, oid: 'f', lfs: { oid: sha('f'), size: 310_000_000 } },
];

describe('pinning the built-in EmbeddingGemma 2 model', () => {
  test('names the variant after the ONNX file', () => {
    expect(variantOf('onnx/model.onnx')).toBe('fp32');
    expect(variantOf('onnx/model_quantized.onnx')).toBe('int8');
    expect(variantOf('onnx/model_q4f16.onnx')).toBe('q4f16');
  });

  test('pins a single-file graph and a graph with external weights', () => {
    const options = { repository: 'onnx-community/embeddinggemma-2-ONNX', commit: COMMIT, tokenizer: 'tokenizer.model' };
    const int8 = pinFromTree(TREE, { ...options, model: 'onnx/model_quantized.onnx' });
    expect(int8).toEqual({
      modelId: 'embeddinggemma-2-int8-0123456',
      repository: 'onnx-community/embeddinggemma-2-ONNX',
      revision: COMMIT,
      model: { name: 'model_quantized.onnx', path: 'onnx/model_quantized.onnx', bytes: 310_000_000, sha256: sha('f') },
      tokenizerRepository: 'onnx-community/embeddinggemma-2-ONNX',
      tokenizerRevision: COMMIT,
      vocabulary: { name: 'tokenizer.model', path: 'tokenizer.model', bytes: 4_689_016, sha256: sha('b') },
    });
    expect(pinFromTree(TREE, { ...options, model: 'onnx/model.onnx' }).modelData)
      .toEqual({ name: 'model.onnx_data', path: 'onnx/model.onnx_data', bytes: 1_200_000_000, sha256: sha('e') });
    expect(() => pinFromTree(TREE, { ...options, model: 'onnx/missing.onnx' })).toThrow('has no onnx/missing.onnx');
    expect(() => pinFromTree(TREE, { ...options, model: 'onnx/model.onnx', tokenizer: 'config.json' })).toThrow('not an LFS file');
  });

  test('pins the tokenizer from another repository\'s commit when the model repository lacks it', () => {
    const tokenizerCommit = 'fedcba9876543210fedcba9876543210fedcba98';
    const onnxOnly = TREE.filter((entry) => entry.path !== 'tokenizer.model');
    const options = { repository: 'onnx-community/embeddinggemma-2-ONNX', commit: COMMIT, model: 'onnx/model_quantized.onnx', tokenizer: 'tokenizer.model' };
    expect(() => pinFromTree(onnxOnly, options)).toThrow('has no tokenizer.model');
    const pin = pinFromTree(onnxOnly, {
      ...options,
      tokenizerTree: {
        repository: 'google/embeddinggemma-2',
        commit: tokenizerCommit,
        tree: [{ type: 'file', path: 'tokenizer.model', size: 4_689_013, oid: 'g', lfs: { oid: sha('9'), size: 4_689_013 } }],
      },
    });
    expect(pin).toMatchObject({
      revision: COMMIT,
      tokenizerRepository: 'google/embeddinggemma-2',
      tokenizerRevision: tokenizerCommit,
      vocabulary: { name: 'tokenizer.model', path: 'tokenizer.model', bytes: 4_689_013, sha256: sha('9') },
    });
    expect(renderPinBlock(pin)).toContain(`tokenizerRevision: '${tokenizerCommit}',`);
  });

  test('rewrites only the manifest\'s PINNED block, and the result still compiles to the same shape', () => {
    const manifest = readFileSync(join(import.meta.dir, '..', 'src/workers/source-index/built-in-embedding/manifest.ts'), 'utf8');
    const pin = pinFromTree(TREE, {
      repository: 'onnx-community/embeddinggemma-2-ONNX',
      commit: COMMIT,
      model: 'onnx/model.onnx',
      tokenizer: 'tokenizer.model',
    });
    const { text, previousModelId } = replacePinBlock(manifest, renderPinBlock(pin));
    expect(previousModelId).toBe(EMBEDDINGGEMMA_2.modelId);
    expect(text).toContain("modelId: 'embeddinggemma-2-fp32-0123456',");
    expect(text).toContain("bytes: 1_200_000_000, sha256: '" + sha('e') + "'");
    const outside = (source: string) => source.replace(/\/\/ BEGIN PINNED[\s\S]*\/\/ END PINNED embeddinggemma-2/, '');
    expect(outside(text)).toBe(outside(manifest));
    // Applying the same pin twice changes nothing more.
    expect(replacePinBlock(text, renderPinBlock(pin)).text).toBe(text);
  });
});
