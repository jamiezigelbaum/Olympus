import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onnxRuntimeFromDirectory } from '../src/workers/source-index/built-in-embedding/runtime.ts';

const root = mkdtempSync(join(tmpdir(), 'olympus-ort-pack-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeOrt(dir: string, marker: string): void {
  const pack = join(dir, 'node_modules', 'onnxruntime-node');
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(pack, 'package.json'), JSON.stringify({ name: 'onnxruntime-node', main: 'index.js' }));
  writeFileSync(join(pack, 'index.js'), `module.exports = { Tensor: class {}, InferenceSession: { async create() {
    return { inputNames: ['input_ids'], outputNames: ['${marker}'], async run() { return {}; }, async release() {} };
  } } };`);
}

test('a missing pack refuses an onnxruntime-node found outside it (a parent folder or a global cache)', async () => {
  // A LiteRT-only data root: no ONNX pack, but a stray copy further up the tree.
  const stray = join(root, 'stray');
  fakeOrt(stray, 'stray');
  const runtimeDir = join(stray, 'models', 'built-in-embedding', 'onnxruntime-1.30.0-linux-x64');
  await expect(onnxRuntimeFromDirectory(runtimeDir).createSession('model.onnx', { threads: 1 }))
    .rejects.toThrow('The ONNX Runtime pack is not installed');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, 'olympus-runtime.json'), '{}');
  await expect(onnxRuntimeFromDirectory(runtimeDir).createSession('model.onnx', { threads: 1 }))
    .rejects.toThrow('The ONNX Runtime pack is not installed');
});

test('the installed pack loads', async () => {
  const runtimeDir = join(root, 'installed', 'onnxruntime-1.30.0-linux-x64');
  fakeOrt(runtimeDir, 'from_pack');
  writeFileSync(join(runtimeDir, 'olympus-runtime.json'), '{}');
  const session = await onnxRuntimeFromDirectory(runtimeDir).createSession('model.onnx', { threads: 1 });
  await session.release?.();
});
