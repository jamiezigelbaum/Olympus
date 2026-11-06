import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuiltInSourceEmbeddingProvider } from '../src/workers/source-index/built-in-embedding/provider.ts';
import { ARCTIC_EMBED_M_V1_5, EMBEDDINGGEMMA_2 } from '../src/workers/source-index/built-in-embedding/manifest.ts';
import { withPriorityQueryEmbedding } from '../src/workers/source-index/embeddings.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('a probe query completes while an already running analysis embedding batch is held', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'embedding-priority-'));
  dirs.push(dir);
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { started = resolve; });
  const calls: Array<{ helper: number; text: string }> = [];
  const options: Array<{ visionTokensPerImage?: number }> = [];
  let helpers = 0;
  const provider = new BuiltInSourceEmbeddingProvider({
    env: { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir },
    model: { ...EMBEDDINGGEMMA_2, dimension: 4 },
    install: async () => ({ modelPath: join(dir, 'model'), libraryPath: join(dir, 'library'), runtimeDir: dir }),
    liteRt: async (settings) => {
      options.push(settings);
      const helper = helpers++;
      return {
        device: 'cpu', vision: settings.visionTokensPerImage !== undefined,
        async embed(items) {
          const text = typeof items[0] === 'string' ? items[0] : items[0]!.text;
          calls.push({ helper, text });
          if (text.includes('analysis passage')) { started(); await held; }
          return items.map(() => new Float32Array([1, 2, 3, 4]));
        },
        async release() {},
      };
    },
  });
  await provider.prepare();
  const analysis = provider.embed([{ text: 'analysis passage' }], { taskType: 'RETRIEVAL_DOCUMENT' });
  await running;
  let ordinaryAnswered = false;
  const ordinary = provider.embed([{ text: 'ordinary question' }], { taskType: 'RETRIEVAL_QUERY' }).then(() => { ordinaryAnswered = true; });
  try {
    // Local searches use this wrapper, which cannot start a runtime.
    const probe = withPriorityQueryEmbedding(() => provider.loadedOnly().embed([{ text: 'probe question' }], { taskType: 'RETRIEVAL_QUERY' }));
    expect(await Promise.race([probe.then(() => 'answered'), Bun.sleep(100).then(() => 'blocked')])).toBe('answered');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.helper).not.toBe(calls[1]!.helper);
    expect(options).toHaveLength(2);
    expect(options[1]!.visionTokensPerImage).toBeUndefined();
    expect(ordinaryAnswered).toBe(false); // The priority scope does not change the ordinary queue.
  } finally {
    release();
    await analysis;
    await ordinary;
  }
});

test('the reserved runtime serializes probes while ordinary queries keep their own slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'embedding-priority-'));
  dirs.push(dir);
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { started = resolve; });
  const calls: string[] = [];
  const provider = new BuiltInSourceEmbeddingProvider({
    env: { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir },
    model: { ...EMBEDDINGGEMMA_2, dimension: 4 },
    install: async () => ({ modelPath: join(dir, 'model'), libraryPath: join(dir, 'library'), runtimeDir: dir }),
    liteRt: async () => ({
      device: 'cpu', vision: false,
      async embed(items) {
        const text = typeof items[0] === 'string' ? items[0] : items[0]!.text;
        calls.push(text);
        if (text.includes('first probe')) { started(); await held; }
        return items.map(() => new Float32Array([1, 2, 3, 4]));
      },
      async release() {},
    }),
  });
  await provider.prepare();
  const first = withPriorityQueryEmbedding(() => provider.embed([{ text: 'first probe' }], { taskType: 'RETRIEVAL_QUERY' }));
  await running;
  const second = withPriorityQueryEmbedding(() => provider.embed([{ text: 'second probe' }], { taskType: 'RETRIEVAL_QUERY' }));
  try {
    await provider.embed([{ text: 'ordinary question' }], { taskType: 'RETRIEVAL_QUERY' });
    expect(calls.map((text) => text.split('query: ')[1])).toEqual(['first probe', 'ordinary question']);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  expect(calls.at(-1)).toContain('second probe');
});

test('a probe also bypasses an active forward pass on an existing ONNX install', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'embedding-priority-'));
  dirs.push(dir);
  const vocabularyPath = join(dir, 'vocab.txt');
  writeFileSync(vocabularyPath, '[PAD]\n[UNK]\n[CLS]\n[SEP]\n[MASK]\nhello\n');
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { started = resolve; });
  let sessions = 0;
  const used: number[] = [];
  const provider = new BuiltInSourceEmbeddingProvider({
    env: { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir },
    model: { ...ARCTIC_EMBED_M_V1_5, dimension: 2 },
    install: async () => ({ modelPath: join(dir, 'model'), vocabularyPath, runtimeDir: dir }),
    runtime: () => ({
      async createSession() {
        const session = sessions++;
        return {
          async run(batch) {
            used.push(session);
            if (session === 0) { started(); await held; }
            return { data: new Float32Array(batch.batchSize * batch.sequenceLength * 2).fill(1), dims: [batch.batchSize, batch.sequenceLength, 2] };
          },
        };
      },
    }),
  });
  await provider.prepare();
  const analysis = provider.embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_DOCUMENT' });
  await running;
  try {
    const probe = withPriorityQueryEmbedding(() => provider.loadedOnly().embed([{ text: 'hello' }], { taskType: 'RETRIEVAL_QUERY' }));
    expect(await Promise.race([probe.then(() => 'answered'), Bun.sleep(100).then(() => 'blocked')])).toBe('answered');
    expect(used).toEqual([0, 1]);
  } finally {
    release();
    await analysis;
  }
});
