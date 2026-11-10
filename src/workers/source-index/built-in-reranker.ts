// The built-in reranker (issue #921): a BERT cross-encoder run by the same
// ONNX Runtime pack and WordPiece tokenizer the built-in embedding model uses,
// on this computer. It reads the query and one candidate's text together and
// returns that pair's relevance logit (core/evidence-reranker.ts).
//
// Off by default. `OLYMPUS_SOURCE_RERANKER=built-in` turns it on with a model
// directory the owner supplies (`model.onnx` and `vocab.txt`), for measuring
// candidate models on the held-out eval and on test-mac or Delphi. Choosing a
// default, and pinning its files by size and SHA-256 in a manifest like the
// embedding model's, follows that measurement.

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

export const SOURCE_RERANKER_ENV = 'OLYMPUS_SOURCE_RERANKER';
export const SOURCE_RERANKER_MODEL_DIR_ENV = 'OLYMPUS_SOURCE_RERANKER_MODEL_DIR';
export const SOURCE_RERANKER_POOL_ENV = 'OLYMPUS_SOURCE_RERANKER_POOL';
export const SOURCE_RERANKER_THREADS_ENV = 'OLYMPUS_SOURCE_RERANKER_THREADS';
export const SOURCE_RERANKER_RUNTIME_DIR_ENV = 'OLYMPUS_SOURCE_RERANKER_ONNX_RUNTIME_DIR';

/** Tokens per (query, passage) pair, specials included: the BERT cross-encoders' window. */
const MAX_PAIR_TOKENS = 512;
/** Pairs per ONNX run. */
const BATCH_SIZE = 8;

export interface CrossEncoderRerankerOptions {
  id: string;
  /** Loaded on first use, once; a failed load is retried on the next question. */
  session: () => Promise<EmbeddingSession>;
  tokenizer: WordPieceTokenizer;
  poolSize?: number;
  maxPairTokens?: number;
  batchSize?: number;
}

export function createCrossEncoderReranker(options: CrossEncoderRerankerOptions): EvidenceReranker {
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

/**
 * The reranker this install configured, or undefined when it is off (the
 * default) or misconfigured. Reads only settings and file presence here; the
 * model loads on the first question.
 */
export function builtInRerankerFromEnv(options: BuiltInRerankerFromEnvOptions = {}): EvidenceReranker | undefined {
  const env = options.env ?? process.env;
  if (env[SOURCE_RERANKER_ENV]?.trim().toLowerCase() !== 'built-in') return undefined;
  const modelDir = env[SOURCE_RERANKER_MODEL_DIR_ENV]?.trim();
  if (!modelDir || !isAbsolute(modelDir)) return undefined;
  const modelPath = join(modelDir, 'model.onnx');
  const vocabularyPath = join(modelDir, 'vocab.txt');
  if (!existsSync(modelPath) || !existsSync(vocabularyPath)) return undefined;
  const runtimeDir = env[SOURCE_RERANKER_RUNTIME_DIR_ENV]?.trim()
    || builtInEmbeddingPaths(env, ARCTIC_EMBED_M_V1_5).runtimeDir;
  const runtime = options.runtime ?? onnxRuntimeFromDirectory(runtimeDir);
  const threads = positiveInteger(env[SOURCE_RERANKER_THREADS_ENV])
    ?? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
  const poolSize = positiveInteger(env[SOURCE_RERANKER_POOL_ENV]);
  return createCrossEncoderReranker({
    id: `cross-encoder:${modelDir.split(/[\\/]/).filter(Boolean).pop() ?? 'model'}`,
    session: () => runtime.createSession(modelPath, { threads }),
    tokenizer: new WordPieceTokenizer(readFileSync(vocabularyPath, 'utf8')),
    ...(poolSize !== undefined ? { poolSize } : {}),
  });
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
