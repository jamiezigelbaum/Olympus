/**
 * Planning estimates for embedding work: USD per million input tokens and
 * chunks per minute, per embedding model.
 *
 * Every figure derived from these is an ESTIMATE and says so. The defaults are
 * UNVERIFIED list prices (per-item four-tier design, section 4.4); the owner
 * reads the live price before approving work, and an install can name its own
 * figures in `sourceIndex.embeddingPriceEstimates`.
 */
export interface EmbeddingModelEstimate {
  usdPerMillionTokens: number;
  chunksPerMinute: number;
}

export type EmbeddingPriceTable = Readonly<Record<string, Partial<EmbeddingModelEstimate>>>;

export const DEFAULT_EMBEDDING_MODEL_ESTIMATES: Readonly<Record<string, EmbeddingModelEstimate>> = {
  'gemini-embedding-2': { usdPerMillionTokens: 0.15, chunksPerMinute: 600 },
  'text-embedding-qwen3-8b': { usdPerMillionTokens: 0.0125, chunksPerMinute: 300 },
  'secure-local-qwen3-embed': { usdPerMillionTokens: 0, chunksPerMinute: 60 },
};

export const FALLBACK_EMBEDDING_MODEL_ESTIMATE: EmbeddingModelEstimate = { usdPerMillionTokens: 0.15, chunksPerMinute: 60 };

/** The estimate for a model: the install's own figure when it names one, else the unverified default. */
export function embeddingModelEstimate(
  modelId: string,
  prices?: EmbeddingPriceTable,
): { estimate: EmbeddingModelEstimate; source: 'config' | 'default_unverified' } {
  const configured = prices?.[modelId];
  const fallback = DEFAULT_EMBEDDING_MODEL_ESTIMATES[modelId] ?? FALLBACK_EMBEDDING_MODEL_ESTIMATE;
  if (configured && typeof configured.usdPerMillionTokens === 'number') {
    return {
      estimate: {
        usdPerMillionTokens: configured.usdPerMillionTokens,
        chunksPerMinute: configured.chunksPerMinute ?? fallback.chunksPerMinute,
      },
      source: 'config',
    };
  }
  return { estimate: fallback, source: 'default_unverified' };
}

/** Estimated USD for `tokens` input tokens on `modelId`, rounded to cents. */
export function estimatedEmbeddingCostUsd(tokens: number, modelId: string, prices?: EmbeddingPriceTable): number {
  const { estimate } = embeddingModelEstimate(modelId, prices);
  return Math.round((tokens / 1_000_000) * estimate.usdPerMillionTokens * 100) / 100;
}
