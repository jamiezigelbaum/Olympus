// The built-in reranker (issue #921): a cross-encoder run by the same
// ONNX Runtime pack shared with the ONNX embedding models,
// on this computer. It reads the query and one candidate's text together and
// returns that pair's relevance logit (core/evidence-reranker.ts).
//
// Installed with the embedding model (~136 MB). On by default with at least
// 16 GiB RAM once the files are present; OLYMPUS_SOURCE_RERANKER=off opts out.
// Explicit built-in also enables smaller computers and optional model paths.
// Scoring stays on this computer, falls back to fused order until installed,
// and releases the session after ten idle minutes, reloading on demand.

import { isMainThread } from 'node:worker_threads';
import { modelThread, modelThreadHandleId } from './built-in-reasoning/off-thread.ts';
import { availableParallelism, totalmem } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  DEFAULT_RERANK_POOL_SIZE,
  type EvidenceReranker,
  type EvidenceRerankRequest,
  type RerankTimers,
} from '../../core/evidence-reranker.ts';
import { builtInEmbeddingPaths, builtInOnnxRuntimeInstalled } from './built-in-embedding/assets.ts';
import { MMARCO_MMINILMV2_L12_H384_V1 } from './built-in-reranker-manifest.ts';
import { ARCTIC_EMBED_M_V1_5 } from './built-in-embedding/manifest.ts';
import { onnxRuntimeFromDirectory, type EmbeddingRuntime, type EmbeddingSession } from './built-in-embedding/runtime.ts';
import { WordPieceTokenizer } from './built-in-embedding/wordpiece.ts';
import { JsonPairTokenizer } from './built-in-embedding/json-tokenizer.ts';
import type { PairTokenizer } from './built-in-embedding/pair-tokenizer.ts';

export { BUILT_IN_RERANKER_MODELS } from './built-in-reranker-manifest.ts';

export const SOURCE_RERANKER_ENV = 'OLYMPUS_SOURCE_RERANKER';
export const SOURCE_RERANKER_MODEL_DIR_ENV = 'OLYMPUS_SOURCE_RERANKER_MODEL_DIR';
export const SOURCE_RERANKER_POOL_ENV = 'OLYMPUS_SOURCE_RERANKER_POOL';
export const SOURCE_RERANKER_THREADS_ENV = 'OLYMPUS_SOURCE_RERANKER_THREADS';
export const SOURCE_RERANKER_RUNTIME_DIR_ENV = 'OLYMPUS_SOURCE_RERANKER_ONNX_RUNTIME_DIR';
/** Tokens of each query and passage pair the model reads (default 256). A shorter window scores a bigger pool (#921). */
export const SOURCE_RERANKER_MAX_TOKENS_ENV = 'OLYMPUS_SOURCE_RERANKER_MAX_TOKENS';

/** Tokens per (query, passage) pair, including the model's special tokens. */
const MAX_PAIR_TOKENS = 512;
/** Pairs per ONNX run. */
const BATCH_SIZE = 8;
/** Default pair window, measured on the passage compare (#921); the env override is capped at MAX_PAIR_TOKENS. */
const DEFAULT_PAIR_TOKENS = 256;
/** Release the loaded session after this long with no score; resource pacing only, never cuts a score short. */
const IDLE_RELEASE_MS = 10 * 60_000;
/** Physical RAM at which the reranker turns on without OLYMPUS_SOURCE_RERANKER=built-in (README model-size split). */
const DEFAULT_ON_MIN_MEMORY_BYTES = 16 * 1024 ** 3;

export interface CrossEncoderRerankerOptions {
  id: string;
  timers?: RerankTimers;
  /** Loaded by prepare() or score(); retried after failure or idle release. */
  session: () => Promise<EmbeddingSession>;
  tokenizer: PairTokenizer;
  poolSize?: number;
  maxPairTokens?: number;
  batchSize?: number;
}

export interface CrossEncoderReranker extends EvidenceReranker {
  /** Load at engine startup, outside any question's stage deadline. */
  prepare(): Promise<void>;
}

export function createCrossEncoderReranker(options: CrossEncoderRerankerOptions): CrossEncoderReranker {
  const maxPairTokens = options.maxPairTokens ?? DEFAULT_PAIR_TOKENS;
  const batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE);
  const timers: RerankTimers = options.timers ?? {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let loading: Promise<EmbeddingSession> | undefined;
  let releasing: Promise<void> | undefined;
  let active = 0;
  let lastActivity = timers.now();
  let idleTimer: unknown;
  const cancelIdle = () => {
    if (idleTimer !== undefined) timers.clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdle = () => {
    cancelIdle();
    if (active || !loading || releasing) return;
    idleTimer = timers.setTimeout(() => {
      idleTimer = undefined;
      if (active || !loading) return;
      const previous = loading;
      loading = undefined;
      releasing = previous.then((model) => model.release?.())
        .catch(() => undefined)
        .finally(() => { releasing = undefined; });
    }, Math.max(0, IDLE_RELEASE_MS - (timers.now() - lastActivity)));
    (idleTimer as { unref?: () => void } | undefined)?.unref?.();
  };
  const session = async () => {
    if (releasing) await releasing;
    loading ??= options.session().catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
  return {
    id: options.id,
    localOnly: true,
    poolSize: options.poolSize ?? DEFAULT_RERANK_POOL_SIZE,
    async prepare() {
      active++;
      cancelIdle();
      lastActivity = timers.now();
      try { await session(); } finally { active--; armIdle(); }
    },
    async score(request: EvidenceRerankRequest) {
      active++;
      cancelIdle();
      lastActivity = timers.now();
      try {
        const model = await session();
        const scores: number[] = [];
        for (let start = 0; start < request.passages.length; start += batchSize) {
          if (request.signal.aborted) throw new Error('Reranking was abandoned.');
          const pairs = request.passages
            .slice(start, start + batchSize)
            .map((passage) => options.tokenizer.encodePair(request.query, passage, maxPairTokens));
          const sequenceLength = Math.max(...pairs.map((pair) => pair.ids.length));
          const size = pairs.length * sequenceLength;
          const inputIds = new BigInt64Array(size).fill(BigInt(options.tokenizer.padId));
          const attentionMask = new BigInt64Array(size);
          const tokenTypeIds = new BigInt64Array(size);
          pairs.forEach((pair, row) => {
            pair.ids.forEach((id, column) => {
              const at = row * sequenceLength + column;
              inputIds[at] = BigInt(id);
              attentionMask[at] = 1n;
              tokenTypeIds[at] = BigInt(pair.typeIds[column]!);
            });
          });
          const output = await model.run({ inputIds, attentionMask, tokenTypeIds, batchSize: pairs.length, sequenceLength });
          // A single-logit relevance head: `[batch, 1]`. Anything else is not a cross-encoder.
          if (output.dims.length !== 2 || output.dims[0] !== pairs.length || output.dims[1] !== 1) {
            throw new Error('The reranker model returned an unexpected output.');
          }
          scores.push(...output.data);
        }
        return scores;
      } finally { active--; armIdle(); }
    },
  };
}

export interface BuiltInRerankerFromEnvOptions {
  env?: Record<string, string | undefined>;
  runtime?: EmbeddingRuntime;
  /** Physical RAM in bytes; injectable so activation does not depend on the test host. */
  totalmem?: () => number;
}

/** Startup boundary shared by the engine and the real-eval runner. */
export async function prepareBuiltInRerankerFromEnv(
  options: BuiltInRerankerFromEnvOptions = {},
  warn: (message: string) => void = console.warn,
): Promise<CrossEncoderReranker | undefined> {
  const reranker = builtInRerankerFromEnv(options);
  await reranker?.prepare().catch(() => {
    // Reranking is optional. The session cache clears a rejected load, so a
    // later question can retry while the normal scoring stage fails open.
    warn('[reranker] Could not load the model at startup; scoring will retry.');
  });
  return reranker;
}

/**
 * Whether the built-in reranker may turn on here: set to built-in, or unset
 * (or blank) on a machine with the default's 16 GiB of RAM. Health and the
 * boot download follow this, so a smaller machine neither downloads it nor
 * reports it as on.
 */
export function builtInRerankerMayRun(
  env: Record<string, string | undefined> = process.env,
  memory: () => number = totalmem,
): boolean {
  const mode = env[SOURCE_RERANKER_ENV]?.trim().toLowerCase() || undefined;
  if (mode === 'built-in') return true;
  return mode === undefined && memory() >= DEFAULT_ON_MIN_MEMORY_BYTES;
}

/**
 * The reranker for a long-running engine: checks again on each call until the
 * installed files appear (the download runs after the engine starts), then
 * keeps that one reranker and loads it in the background. Off, or below the
 * RAM threshold, it stays undefined.
 */
export function createBuiltInRerankerResolver(
  options: BuiltInRerankerFromEnvOptions = {},
  warn: (message: string) => void = console.warn,
): () => CrossEncoderReranker | undefined {
  let found: CrossEncoderReranker | undefined;
  return () => {
    if (found) return found;
    found = builtInRerankerFromEnv(options);
    void found?.prepare().catch(() => warn('[reranker] Could not load the model; scoring will retry.'));
    return found;
  };
}

/**
 * The installed reranker, or undefined when disabled, below the default RAM
 * threshold, or missing its files. The engine awaits prepare() before serving.
 */
export function builtInRerankerFromEnv(options: BuiltInRerankerFromEnvOptions = {}): CrossEncoderReranker | undefined {
  const env = options.env ?? process.env;
  if (!builtInRerankerMayRun(env, options.totalmem)) return undefined;
  const mode = env[SOURCE_RERANKER_ENV]?.trim().toLowerCase() || undefined;
  const modelDir = (mode === 'built-in' ? env[SOURCE_RERANKER_MODEL_DIR_ENV]?.trim() : undefined)
    || join(builtInEmbeddingPaths(env).root, 'reranker', MMARCO_MMINILMV2_L12_H384_V1.modelId);
  if (!modelDir || !isAbsolute(modelDir)) return undefined;
  const modelPath = join(modelDir, 'model.onnx');
  const vocabularyPath = join(modelDir, 'vocab.txt');
  const tokenizerPath = join(modelDir, 'tokenizer.json');
  if (!existsSync(modelPath) || (!existsSync(vocabularyPath) && !existsSync(tokenizerPath))) return undefined;
  const runtimeOverride = env[SOURCE_RERANKER_RUNTIME_DIR_ENV]?.trim();
  const runtimeDir = runtimeOverride || builtInEmbeddingPaths(env, ARCTIC_EMBED_M_V1_5).runtimeDir;
  // The model files land before the runtime; until the pinned runtime is in
  // place too, loading would fail every question, so the reranker stays off.
  if (!options.runtime && !runtimeOverride && !builtInOnnxRuntimeInstalled(runtimeDir)) return undefined;
  if (isMainThread && !options.runtime) {
    const handle = modelThreadHandleId();
    let loading: Promise<void> | undefined;
    const prepare = () => loading ??= modelThread().call<void>({ kind: 'reranker-load', handle, env }).catch(error => {
      loading = undefined;
      throw error;
    });
    return {
      id: `cross-encoder:${modelDir.split(/[\\/]/).filter(Boolean).pop() ?? 'model'}`,
      localOnly: true,
      poolSize: positiveInteger(env[SOURCE_RERANKER_POOL_ENV]) ?? DEFAULT_RERANK_POOL_SIZE,
      prepare,
      async score({ signal, ...request }) {
        if (signal.aborted) throw new Error('Reranking was abandoned.');
        await prepare();
        return modelThread().call<number[]>({ kind: 'reranker-run', handle, request }, { signal });
      },
    };
  }
  const runtime = options.runtime ?? onnxRuntimeFromDirectory(runtimeDir);
  const threads = positiveInteger(env[SOURCE_RERANKER_THREADS_ENV])
    ?? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
  const poolSize = positiveInteger(env[SOURCE_RERANKER_POOL_ENV]);
  const maxTokens = positiveInteger(env[SOURCE_RERANKER_MAX_TOKENS_ENV]);
  const maxPairTokens = maxTokens === undefined ? undefined : Math.min(MAX_PAIR_TOKENS, Math.max(32, maxTokens));
  return createCrossEncoderReranker({
    id: `cross-encoder:${modelDir.split(/[\\/]/).filter(Boolean).pop() ?? 'model'}`,
    session: () => runtime.createSession(modelPath, { threads }),
    tokenizer: existsSync(vocabularyPath)
      ? new WordPieceTokenizer(readFileSync(vocabularyPath, 'utf8'))
      : new JsonPairTokenizer(readFileSync(tokenizerPath, 'utf8')),
    ...(poolSize !== undefined ? { poolSize } : {}),
    ...(maxPairTokens !== undefined ? { maxPairTokens } : {}),
  });
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
