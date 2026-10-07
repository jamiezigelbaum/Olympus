// The seam between the built-in embedding provider and ONNX Runtime. The real
// runtime is loaded at run time from the verified pack in the data directory
// (never bundled: the plugin ships as one JavaScript file and the native
// binding is per-platform), so a test can substitute any `EmbeddingRuntime`.

import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface EmbeddingBatch {
  inputIds: BigInt64Array;
  attentionMask: BigInt64Array;
  tokenTypeIds: BigInt64Array;
  batchSize: number;
  sequenceLength: number;
}

export interface EmbeddingSessionOutput {
  /** Row-major: `[batch, sequence, hidden]` for `last_hidden_state`, `[batch, hidden]` for `sentence_embedding`. */
  data: Float32Array;
  dims: readonly number[];
}

export interface EmbeddingSession {
  run(batch: EmbeddingBatch): Promise<EmbeddingSessionOutput>;
  release?(): Promise<void>;
}

export interface EmbeddingSessionOptions {
  threads: number;
  /** The graph output to read; absent, `last_hidden_state` (or the first output). */
  output?: 'last_hidden_state' | 'sentence_embedding';
}

export interface EmbeddingRuntime {
  createSession(modelPath: string, options: EmbeddingSessionOptions): Promise<EmbeddingSession>;
}

interface OrtTensor {
  data: unknown;
  dims: readonly number[];
}

interface OrtValueMetadata {
  name: string;
  isTensor: boolean;
  shape?: ReadonlyArray<number | string>;
}

interface OrtSession {
  inputNames: readonly string[];
  inputMetadata?: readonly OrtValueMetadata[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}

interface OrtModule {
  Tensor: {
    new (type: 'int64', data: BigInt64Array, dims: readonly number[]): OrtTensor;
    new (type: 'float32', data: Float32Array, dims: readonly number[]): OrtTensor;
  };
  InferenceSession: {
    create(path: string, options: Record<string, unknown>): Promise<OrtSession>;
  };
}

/** ONNX Runtime loaded from `<runtimeDir>/node_modules/onnxruntime-node`. */
export function onnxRuntimeFromDirectory(runtimeDir: string): EmbeddingRuntime {
  return {
    async createSession(modelPath, options) {
      const requireFromPack = createRequire(join(runtimeDir, 'olympus-runtime.json'));
      const ort = requireFromPack('onnxruntime-node') as OrtModule;
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        intraOpNumThreads: options.threads,
        interOpNumThreads: 1,
        executionMode: 'sequential',
        graphOptimizationLevel: 'all',
        // The arena keeps the peak of the largest batch forever; without it
        // memory returns to the system between batches.
        enableCpuMemArena: false,
      });
      // Free the native session before the process exits: tearing ONNX
      // Runtime's thread pool down from static destructors after inference
      // has crashed Bun at exit.
      const releaseAtExit = () => { void session.release().catch(() => undefined); };
      process.once('exit', releaseAtExit);
      const wantsTokenTypes = session.inputNames.includes('token_type_ids');
      // A multimodal graph (EmbeddingGemma 2) also requires its image, video
      // and audio feature inputs; text embeds with each of them empty.
      const emptyFeatures = session.inputNames
        .filter((name) => !['input_ids', 'attention_mask', 'token_type_ids'].includes(name))
        .map((name) => {
          const width = session.inputMetadata?.find((input) => input.name === name)?.shape?.[1];
          if (!name.endsWith('_features') || typeof width !== 'number') {
            throw new Error(`The built-in search model needs an input this runtime cannot feed: ${name}.`);
          }
          return [name, new ort.Tensor('float32', new Float32Array(0), [0, width])] as const;
        });
      // The per-token output goes by several names (Arctic's graph calls it
      // `token_embeddings`); a pooled output must be the one asked for.
      const pooled = options.output === 'sentence_embedding';
      const outputName = pooled
        ? session.outputNames.find((name) => name === 'sentence_embedding')
        : session.outputNames.includes('last_hidden_state') ? 'last_hidden_state' : session.outputNames[0];
      if (!outputName) {
        throw new Error(`The built-in search model has no ${pooled ? 'sentence_embedding' : ''} output (it has ${session.outputNames.join(', ') || 'none'}).`);
      }
      return {
        async run(batch) {
          const dims = [batch.batchSize, batch.sequenceLength];
          const feeds: Record<string, OrtTensor> = {
            input_ids: new ort.Tensor('int64', batch.inputIds, dims),
            attention_mask: new ort.Tensor('int64', batch.attentionMask, dims),
          };
          if (wantsTokenTypes) feeds.token_type_ids = new ort.Tensor('int64', batch.tokenTypeIds, dims);
          for (const [name, tensor] of emptyFeatures) feeds[name] = tensor;
          const output = (await session.run(feeds))[outputName];
          if (!output || !(output.data instanceof Float32Array)) {
            throw new Error('The built-in search model returned an unexpected output.');
          }
          return { data: output.data, dims: output.dims };
        },
        release: () => {
          process.removeListener('exit', releaseAtExit);
          return session.release();
        },
      };
    },
  };
}
