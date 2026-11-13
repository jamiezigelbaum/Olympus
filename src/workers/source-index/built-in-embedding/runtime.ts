// The seam between the built-in embedding provider and ONNX Runtime. The real
// runtime is loaded at run time from the verified pack in the data directory
// (never bundled: the plugin ships as one JavaScript file and the native
// binding is per-platform), so a test can substitute any `EmbeddingRuntime`.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';

export interface EmbeddingBatch {
  inputIds: BigInt64Array;
  attentionMask: BigInt64Array;
  tokenTypeIds: BigInt64Array;
  batchSize: number;
  sequenceLength: number;
}

export interface EmbeddingSessionOutput {
  /** Row-major `[batch, sequence, hidden]` last hidden state. */
  data: Float32Array;
  dims: readonly number[];
}

export interface EmbeddingSession {
  run(batch: EmbeddingBatch): Promise<EmbeddingSessionOutput>;
  release?(): Promise<void>;
}

export interface EmbeddingRuntime {
  createSession(modelPath: string, options: { threads: number }): Promise<EmbeddingSession>;
}

interface OrtTensor {
  data: unknown;
  dims: readonly number[];
}

interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}

interface OrtModule {
  Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => OrtTensor;
  InferenceSession: {
    create(path: string, options: Record<string, unknown>): Promise<OrtSession>;
  };
}

/** ONNX Runtime loaded from `<runtimeDir>/node_modules/onnxruntime-node`. */
export function onnxRuntimeFromDirectory(runtimeDir: string): EmbeddingRuntime {
  return {
    async createSession(modelPath, options) {
      const ort = requireOnnxRuntimeFromPack(runtimeDir);
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
      const outputName = session.outputNames.includes('last_hidden_state')
        ? 'last_hidden_state'
        : session.outputNames[0];
      if (!outputName) throw new Error('The built-in search model has no outputs.');
      return {
        async run(batch) {
          const dims = [batch.batchSize, batch.sequenceLength];
          const feeds: Record<string, OrtTensor> = {
            input_ids: new ort.Tensor('int64', batch.inputIds, dims),
            attention_mask: new ort.Tensor('int64', batch.attentionMask, dims),
          };
          if (wantsTokenTypes) feeds.token_type_ids = new ort.Tensor('int64', batch.tokenTypeIds, dims);
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

/**
 * Only the verified pack counts. Bun's resolver falls through to its global
 * install cache when the pack is missing, which once let an unpinned
 * onnxruntime-node load on one thread and not another; refuse anything that
 * did not resolve inside `<runtimeDir>/node_modules`.
 */
function requireOnnxRuntimeFromPack(runtimeDir: string): OrtModule {
  const missing = () => new Error(`The ONNX Runtime pack is not installed in ${runtimeDir}.`);
  let root: string;
  let resolved: string;
  const requireFromPack = createRequire(join(runtimeDir, 'olympus-runtime.json'));
  try {
    root = realpathSync(join(runtimeDir, 'node_modules'));
    resolved = realpathSync(requireFromPack.resolve('onnxruntime-node'));
  } catch { throw missing(); }
  if (!resolved.startsWith(root + sep)) throw missing();
  return requireFromPack(resolved) as OrtModule;
}
