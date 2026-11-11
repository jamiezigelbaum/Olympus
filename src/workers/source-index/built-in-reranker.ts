// The built-in reranker (issue #921): a cross-encoder run by the same
// ONNX Runtime pack the built-in embedding model uses,
// on this computer. It reads the query and one candidate's text together and
// returns that pair's relevance logit (core/evidence-reranker.ts).
//
// Off by default. `OLYMPUS_SOURCE_RERANKER=built-in` turns it on with a model
// directory the owner supplies (`model.onnx` and `vocab.txt` or `tokenizer.json`).
// Candidate files are pinned in built-in-reranker-manifest.ts; the search lane
// chooses a default only after measuring the held-out eval.

import { availableParallelism } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  DEFAULT_RERANK_POOL_SIZE,
  type EvidenceReranker,
  type EvidenceRerankRequest,
} from '../../core/evidence-reranker.ts';
import { builtInEmbeddingPaths } from './built-in-embedding/assets.ts';
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
/** Tokens of each query and passage pair the model reads (default 512). A shorter window scores a bigger pool (#921). */
export const SOURCE_RERANKER_MAX_TOKENS_ENV = 'OLYMPUS_SOURCE_RERANKER_MAX_TOKENS';

/** Tokens per (query, passage) pair, including the model's special tokens. */
const MAX_PAIR_TOKENS = 512;
/** Pairs per ONNX run. */
const BATCH_SIZE = 8;

export interface CrossEncoderRerankerOptions {
  id: string;
  /** Loaded once by prepare() or score(); a failed load can be retried. */
  session: () => Promise<EmbeddingSession>;
  tokenizer: PairTokenizer;
  poolSize?: number;
  maxPairTokens?: number;
  batchSize?: number;
}

export interface CrossEncoderReranker extends EvidenceReranker {
  /** Load once at engine startup, outside any question's stage deadline. */
  prepare(): Promise<void>;
}

export function createCrossEncoderReranker(options: CrossEncoderRerankerOptions): CrossEncoderReranker {
  const maxPairTokens = options.maxPairTokens ?? MAX_PAIR_TOKENS;
  const batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE);
  let loading: Promise<EmbeddingSession> | undefined;
  const session = () => {
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
    async prepare() { await session(); },
    async score(request: EvidenceRerankRequest) {
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
    },
  };
}

export interface BuiltInRerankerFromEnvOptions {
  env?: Record<string, string | undefined>;
  runtime?: EmbeddingRuntime;
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
 * The reranker this install configured, or undefined when it is off (the
 * default) or misconfigured. The engine awaits prepare() before serving.
 */
export function builtInRerankerFromEnv(options: BuiltInRerankerFromEnvOptions = {}): CrossEncoderReranker | undefined {
  const env = options.env ?? process.env;
  if (env[SOURCE_RERANKER_ENV]?.trim().toLowerCase() !== 'built-in') return undefined;
  const modelDir = env[SOURCE_RERANKER_MODEL_DIR_ENV]?.trim();
  if (!modelDir || !isAbsolute(modelDir)) return undefined;
  const modelPath = join(modelDir, 'model.onnx');
  const vocabularyPath = join(modelDir, 'vocab.txt');
  const tokenizerPath = join(modelDir, 'tokenizer.json');
  if (!existsSync(modelPath) || (!existsSync(vocabularyPath) && !existsSync(tokenizerPath))) return undefined;
  const runtimeDir = env[SOURCE_RERANKER_RUNTIME_DIR_ENV]?.trim()
    || builtInEmbeddingPaths(env, ARCTIC_EMBED_M_V1_5).runtimeDir;
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
