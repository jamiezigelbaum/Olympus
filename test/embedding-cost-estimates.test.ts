import { expect, test } from 'bun:test';
import { estimatedEmbeddingCostUsd } from '../src/core/embedding-cost-estimates.ts';

test('Venice paid backlogs retain a visible cost below one cent', () => {
  expect(estimatedEmbeddingCostUsd(100_000, 'text-embedding-qwen3-8b')).toBe(0.01);
  expect(estimatedEmbeddingCostUsd(1_000_000, 'text-embedding-qwen3-8b')).toBe(0.02);
  expect(estimatedEmbeddingCostUsd(0, 'text-embedding-qwen3-8b')).toBe(0);
  expect(estimatedEmbeddingCostUsd(100_000, 'secure-local-qwen3-embed')).toBe(0);
  expect(estimatedEmbeddingCostUsd(100_000, 'text-embedding-qwen3-8b', { 'text-embedding-qwen3-8b': { usdPerMillionTokens: 0 } })).toBe(0);
});
