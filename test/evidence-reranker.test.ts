import { describe, expect, test } from 'bun:test';
import {
  buildEvidencePackDetailed,
  type LocalContentProvider,
} from '../src/core/evidence-pack.ts';
import {
  rerankCandidates,
  rerankPoolSize,
  type EvidenceReranker,
  type RerankTimers,
} from '../src/core/evidence-reranker.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import type { SourceIndexCorpusSearchAdapter } from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { createCrossEncoderReranker } from '../src/workers/source-index/built-in-reranker.ts';
import { WordPieceTokenizer } from '../src/workers/source-index/built-in-embedding/wordpiece.ts';
import type { EmbeddingBatch } from '../src/workers/source-index/built-in-embedding/runtime.ts';
import { SourceModelPolicyDeniedError } from '../src/core/source-model-policy.ts';
import { createTestClock } from './helpers/test-clock.ts';

// A reranker that scores a passage by how many of the query's words it holds:
// a stand-in with a known answer, so the tests check the stage, not a model.
function overlapReranker(poolSize = 30, calls: string[][] = []): EvidenceReranker {
  return {
    id: 'fixture-overlap',
    localOnly: true,
    poolSize,
    async score({ query, passages }) {
      calls.push([...passages]);
      const words = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
      return passages.map((passage) => passage.toLowerCase().split(/\W+/).filter((word) => words.has(word)).length);
    },
  };
}

function timers(clock = createTestClock()): RerankTimers & { clock: ReturnType<typeof createTestClock> } {
  return {
    clock,
    now: () => clock.now(),
    setTimeout: (callback, ms) => clock.setTimeout(callback, ms),
    clearTimeout: (handle) => clock.clearTimeout(handle as Parameters<typeof clock.clearTimeout>[0]),
  };
}

describe('rerankCandidates', () => {
  test('orders by score, keeps the best, and counts promotions from below the cut', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const text: Record<string, string> = { a: 'nothing here', b: 'invoice', c: 'invoice total due', d: 'invoice total' };
    const result = await rerankCandidates({
      reranker: overlapReranker(), query: 'invoice total due', items, passageOf: (item) => text[item]!, keep: 2, timers: timers(),
    });
    expect(result.kept).toEqual(['c', 'd']);
    expect(result.audit).toMatchObject({ outcome: 'applied', scored: 4, kept: 2, promoted: 2 });
  });

  test('a candidate with no text keeps its fused place after the scored ones; ties keep fused order', async () => {
    const text: Record<string, string> = { a: '', b: 'x', c: 'x', d: 'invoice' };
    const result = await rerankCandidates({
      reranker: overlapReranker(), query: 'invoice', items: ['a', 'b', 'c', 'd'], passageOf: (item) => text[item]!, keep: 4, timers: timers(),
    });
    expect(result.kept).toEqual(['d', 'b', 'c', 'a']);
    expect(result.audit.scored).toBe(3);
  });

  test('fails open to the fused cut when the reranker throws or returns the wrong number of scores', async () => {
    const throwing: EvidenceReranker = { id: 't', localOnly: true, poolSize: 10, score: async () => { throw new Error('model missing'); } };
    const short: EvidenceReranker = { id: 's', localOnly: true, poolSize: 10, score: async () => [1] };
    for (const reranker of [throwing, short]) {
      const result = await rerankCandidates({
        reranker, query: 'q', items: ['a', 'b', 'c'], passageOf: () => 'text', keep: 2, timers: timers(),
      });
      expect(result.kept).toEqual(['a', 'b']);
      expect(result.audit.outcome).toBe('failed');
    }
  });

  test('a reranker that does not answer in time is abandoned and the fused order stands', async () => {
    const fake = timers();
    let aborted = false;
    const hanging: EvidenceReranker = {
      id: 'h', localOnly: true, poolSize: 10,
      score: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      }),
    };
    const pending = rerankCandidates({
      reranker: hanging, query: 'q', items: ['a', 'b', 'c'], passageOf: () => 'text', keep: 2, timeoutMs: 1_000, timers: fake,
    });
    await fake.clock.advance(1_000);
    const result = await pending;
    expect(result.kept).toEqual(['a', 'b']);
    expect(result.audit.outcome).toBe('timed_out');
    expect(aborted).toBe(true);
    expect(fake.clock.pendingTimers()).toBe(0);
  });

  test('the pool is never smaller than the cut and never above the ceiling', () => {
    expect(rerankPoolSize(overlapReranker(3), 5)).toBe(5);
    expect(rerankPoolSize(overlapReranker(30), 5)).toBe(30);
    expect(rerankPoolSize(overlapReranker(10_000), 5)).toBe(100);
  });
});

const CORPUS = 'internal.files';

function item(id: string) {
  return { family: 'file' as const, provider: 'fixture', accountScope: 'personal', providerItemId: id, localItemId: id };
}

// Ten hits in fused order; the one that answers the question is ranked last.
function packInput(
  reranker: EvidenceReranker | undefined,
  requested: number[],
  question = 'When is the invoice total due?',
  override?: (id: string) => Awaited<ReturnType<LocalContentProvider['fetchLocalContent']>> | undefined,
) {
  const ids = Array.from({ length: 10 }, (_, index) => `doc-${index}`);
  const text = (id: string) => (id === 'doc-9' ? 'The invoice total is due on 3 March.' : `Unrelated note ${id}.`);
  const adapter: SourceIndexCorpusSearchAdapter = (request) => {
    requested.push(request.maxResults);
    return {
      hits: ids.slice(0, request.maxResults).map((id) => ({
        sourceItem: item(id), provenance: { sourceItem: item(id), citation: { title: id } }, rawExposed: false as const,
      })),
      latencyMs: 1,
      rawExposed: false as const,
    };
  };
  const provider: LocalContentProvider = {
    async fetchLocalContent(request) {
      const overridden = override?.(request.provenance.sourceItem.providerItemId);
      if (overridden) return overridden;
      return {
        sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
        chunks: [text(request.provenance.sourceItem.providerItemId)],
      };
    },
  };
  return {
    question,
    maxResults: 3,
    searchContext: { allowedTrustDomains: ['internal' as const] },
    registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId: CORPUS, family: 'file', trustDomain: 'internal' })]),
    adapters: { [CORPUS]: adapter },
    contentProviders: { [CORPUS]: provider },
    ...(reranker ? { reranker, rerankTimers: timers() } : {}),
  };
}

const packIds = (detail: Awaited<ReturnType<typeof buildEvidencePackDetailed>>) =>
  detail.pack.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId);

describe('buildEvidencePackDetailed with a reranker', () => {
  test('off by default: the fused order and cut are unchanged', async () => {
    const requested: number[] = [];
    const detail = await buildEvidencePackDetailed(packInput(undefined, requested));
    expect(packIds(detail)).toEqual(['doc-0', 'doc-1', 'doc-2']);
    expect(requested).toEqual([3]);
    expect(detail.rerank).toBeUndefined();
  });

  test('retrieves the pool, reads it, and keeps the reranker\'s best within maxResults', async () => {
    const requested: number[] = [];
    const calls: string[][] = [];
    const detail = await buildEvidencePackDetailed(packInput(overlapReranker(10, calls), requested));
    expect(requested).toEqual([10]);
    expect(calls[0]).toHaveLength(10);
    expect(detail.pack.candidates).toHaveLength(3);
    expect(packIds(detail)[0]).toBe('doc-9');
    expect(detail.rerank).toMatchObject({ rerankerId: 'fixture-overlap', outcome: 'applied', scored: 10, kept: 3, promoted: 1 });
  });

  test('S5 content anywhere in the pool hard-stops the build before the reranker reads any text', async () => {
    const calls: string[][] = [];
    // doc-5 is below the cut and irrelevant, so only a pool-wide check sees it.
    const input = packInput(overlapReranker(10, calls), [], undefined, (id) => id === 'doc-5'
      ? { sensitivity: buildSourceSensitivity({ trustTier: 'S5', trustDomain: 'internal' }), chunks: ['SECRET TEXT'] }
      : undefined);
    await expect(buildEvidencePackDetailed(input)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test('a policy-denied item is counted even when readable items fill the cut', async () => {
    const input = packInput(overlapReranker(10), [], undefined, (id) => {
      if (id === 'doc-0') throw new SourceModelPolicyDeniedError();
      return undefined;
    });
    const detail = await buildEvidencePackDetailed(input);
    expect(detail.pack.candidates).toHaveLength(3);
    expect(detail.policyDeniedCandidates).toBe(1);
    expect(detail.policyDeniedCoverageGaps).toHaveLength(1);
  });

  test('a secure item the reranker read but cut still marks the build as having read secure content', async () => {
    const calls: string[][] = [];
    // doc-5 is upgraded to S4 by its provider and is irrelevant, so it is scored and cut.
    const input = packInput(overlapReranker(10, calls), [], undefined, (id) => id === 'doc-5'
      ? { sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }), chunks: ['Private note.'] }
      : undefined);
    const detail = await buildEvidencePackDetailed(input);
    expect(calls[0]).toContain('doc-5 Private note.');
    expect(packIds(detail)).not.toContain('doc-5');
    expect(detail.encounteredSecureLocal).toBe(true);
  });

  test('a question about recency keeps its newest-first order and is not reranked', async () => {
    const requested: number[] = [];
    const detail = await buildEvidencePackDetailed(packInput(overlapReranker(10), requested, 'What is the latest invoice?'));
    expect(requested).toEqual([3]);
    expect(detail.rerank).toBeUndefined();
  });
});

describe('createCrossEncoderReranker', () => {
  const vocabulary = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'invoice', 'total', 'due', 'note'].join('\n');

  test('feeds BERT pairs with segment ids and returns one logit per passage, in batches', async () => {
    const batches: EmbeddingBatch[] = [];
    const reranker = createCrossEncoderReranker({
      id: 'fixture',
      tokenizer: new WordPieceTokenizer(vocabulary),
      batchSize: 2,
      session: async () => ({
        async run(batch) {
          batches.push(batch);
          // The logit is the pair's token count, so the test can check the feed.
          const data = new Float32Array(batch.batchSize);
          for (let row = 0; row < batch.batchSize; row += 1) {
            let count = 0;
            for (let column = 0; column < batch.sequenceLength; column += 1) {
              count += Number(batch.attentionMask[row * batch.sequenceLength + column]);
            }
            data[row] = count;
          }
          return { data, dims: [batch.batchSize, 1] };
        },
      }),
    });
    const scores = await reranker.score({ query: 'invoice', passages: ['total due', 'note', 'invoice total due'], signal: new AbortController().signal });
    expect(scores).toEqual([6, 5, 7]);
    expect(batches.map((batch) => batch.batchSize)).toEqual([2, 1]);
    // [CLS] invoice [SEP] total due [SEP] -> segments 0 0 0 1 1 1
    expect([...batches[0]!.tokenTypeIds.slice(0, 6)]).toEqual([0n, 0n, 0n, 1n, 1n, 1n]);
    expect([...batches[0]!.inputIds.slice(0, 6)]).toEqual([2n, 4n, 3n, 5n, 6n, 3n]);
  });

  test('rejects a model whose output is not a single relevance logit', async () => {
    const reranker = createCrossEncoderReranker({
      id: 'fixture',
      tokenizer: new WordPieceTokenizer(vocabulary),
      session: async () => ({ run: async (batch) => ({ data: new Float32Array(batch.batchSize * 4), dims: [batch.batchSize, 2, 2] }) }),
    });
    await expect(reranker.score({ query: 'invoice', passages: ['note'], signal: new AbortController().signal })).rejects.toThrow('unexpected output');
  });
});

describe('WordPieceTokenizer.encodePair', () => {
  test('cuts the longer text first so the pair fits', () => {
    const tokenizer = new WordPieceTokenizer(['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'a', 'b'].join('\n'));
    const pair = tokenizer.encodePair('a a', 'b b b b b b', 8);
    expect(pair.ids).toEqual([2, 4, 4, 3, 5, 5, 5, 3]);
    expect(pair.typeIds).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(pair.truncated).toBe(true);
  });
});
