import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setEnvironmentData } from 'node:worker_threads';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { BuiltInSourceEmbeddingProvider } from '../src/workers/source-index/built-in-embedding/provider.ts';
import { ARCTIC_EMBED_M_V1_5 } from '../src/workers/source-index/built-in-embedding/manifest.ts';
import { builtInRerankerFromEnv } from '../src/workers/source-index/built-in-reranker.ts';
import { withPriorityQueryEmbedding } from '../src/workers/source-index/embeddings.ts';
import { createTestClock, waitFor } from './helpers/test-clock.ts';

// A native-runtime stand-in. Module loading and every session creation block
// until the parent advances the test clock. The real-time ceiling only keeps
// the deliberately broken, in-process path from deadlocking the test runner.
const state = new Int32Array(new SharedArrayBuffer(8));
setEnvironmentData('olympus-model-responsiveness', state);

for (const kind of ['embedding', 'reranker'] as const) {
  test(`${kind} setup answers /v1/health within 250 ms during dlopen and every session load`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-model-responsive-'));
    const pack = join(root, 'node_modules/onnxruntime-node');
    mkdirSync(pack, { recursive: true });
    state.fill(0);
    writeFileSync(join(pack, 'index.js'), `
      const { getEnvironmentData } = require('node:worker_threads');
      const state = getEnvironmentData('olympus-model-responsiveness');
      function block() {
        const stage = Atomics.add(state, 0, 1) + 1;
        Atomics.wait(state, 1, stage - 1, 600);
      }
      block();
      exports.Tensor = class { constructor(type, data, dims) { this.data = data; this.dims = dims; } };
      let sessions = 0;
      exports.InferenceSession = { async create() {
        block();
        const value = ++sessions;
        return { inputNames: ['input_ids'], outputNames: ['last_hidden_state'],
          async run(feeds) {
            const [rows, tokens] = feeds.input_ids.dims;
            const data = new Float32Array(rows * ${kind === 'embedding' ? 'tokens * 2' : '1'}).fill(value);
            ${kind === 'embedding' ? 'for (let i = 1; i < data.length; i += 2) data[i] = 1;' : ''}
            return { last_hidden_state: { data,
              dims: ${kind === 'embedding' ? '[rows, tokens, 2]' : '[rows, 1]'} } };
          }, async release() {} };
      } };
    `);
    writeFileSync(join(root, 'model.onnx'), 'fixture');
    writeFileSync(join(root, 'vocab.txt'), '[PAD]\n[UNK]\n[CLS]\n[SEP]\nhello');
    const worker = createEmailSourceWorker();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: worker.fetch });
    const clock = createTestClock();
    const provider = new BuiltInSourceEmbeddingProvider({
      model: { ...ARCTIC_EMBED_M_V1_5, dimension: 2 },
      env: { OLYMPUS_BUILT_IN_EMBEDDING_DIR: root },
      install: async () => ({ modelPath: join(root, 'model.onnx'), vocabularyPath: join(root, 'vocab.txt'), runtimeDir: root }),
    });
    const reranker = kind === 'reranker' ? builtInRerankerFromEnv({ env: {
      OLYMPUS_SOURCE_RERANKER: 'built-in', OLYMPUS_SOURCE_RERANKER_MODEL_DIR: root,
      OLYMPUS_SOURCE_RERANKER_ONNX_RUNTIME_DIR: root,
    } })! : undefined;
    let finished = false;
    const preparing = (reranker ? reranker.prepare() : provider.prepare()).then(() => { finished = true; });
    try {
      for (let stage = 1; stage <= (reranker ? 2 : 3); stage++) {
        await waitFor(() => Atomics.load(state, 0) >= stage);
        expect(Atomics.load(state, 0)).toBe(stage);
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/health`, { signal: AbortSignal.timeout(250) });
        expect(response.status).toBe(200);
        await response.json();
        expect(performance.now() - started).toBeLessThan(250);
        expect(finished).toBe(false);
        clock.setTimeout(() => { Atomics.store(state, 1, stage); Atomics.notify(state, 1); }, 600);
        await clock.advance(600);
      }
      await preparing;
      if (reranker) {
        expect(await reranker.score({ query: 'hello', passages: ['hello'], signal: new AbortController().signal })).toEqual([1]);
      } else {
        // Both ordinary and reserved query sessions remain usable over messages.
        const ordinary = await provider.embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_DOCUMENT' });
        const priority = await withPriorityQueryEmbedding(() => provider.loadedOnly().embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_QUERY' }));
        expect(ordinary[0]).toHaveLength(2);
        expect(priority[0]).toHaveLength(2);
        expect(priority[0]![0]!).toBeGreaterThan(ordinary[0]![0]!);
      }
    } finally {
      Atomics.store(state, 1, 100); Atomics.notify(state, 1);
      await preparing.catch(() => {});
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
