import { describe, expect, test } from 'bun:test';
import {
  buildEvidencePackDetailed,
  type LocalContentProvider,
} from '../src/core/evidence-pack.ts';
import {
  rerankCandidates,
  rerankPoolSize,
  MAX_RERANK_POOL_SIZE,
  DEFAULT_RERANK_TIMEOUT_MS,
  rerankPassageWindows,
  RERANK_WINDOW_CHARS,
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
import { createAnalyst, redactPackForEscalation } from '../src/core/analyst.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

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
    expect(rerankPoolSize(overlapReranker(250), 5)).toBe(250);
    expect(MAX_RERANK_POOL_SIZE).toBe(400);
    expect(rerankPoolSize(overlapReranker(10_000), 5)).toBe(400);
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
    expect(detail.rerank).toMatchObject({ rerankerId: 'fixture-overlap', outcome: 'applied', scored: 10, kept: 3, promoted: 1, windowOutcome: 'skipped', windowItems: 0, windowsScored: 0, windowElapsedMs: 0 });
    expect(calls).toHaveLength(1);
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

describe('paragraph window reranking', () => {
  test('sentence windows preserve all text, chunk boundaries, and the tail of an oversized sentence', () => {
    const first = 'A complete sentence. '.repeat(60).trim();
    const oversized = 'x'.repeat(1_201) + '.';
    const windows = rerankPassageWindows([first, oversized]);
    expect(windows.every(text => text.length <= RERANK_WINDOW_CHARS)).toBe(true);
    expect(windows.filter(text => text.startsWith('A')).every(text => text.endsWith('.'))).toBe(true);
    expect(windows.join('').replaceAll(' ', '')).toBe((first + oversized).replaceAll(' ', ''));
  });

  const answer = 'The invoice total is due on 3 March.';
  const original = ['Opening passage without the answer.', 'Existing supporting passage.'];
  const candidates = ['Background sentence. '.repeat(35) + answer + ' Closing sentence.'];
  function windowInput(mode: 'applied' | 'failed' | 'timed_out' | 'malformed' = 'applied') {
    const calls: string[][] = [];
    const fake = timers();
    const reranker: EvidenceReranker = {
      id: 'window-fixture', localOnly: true, poolSize: 10,
      async score({ passages, signal }) {
        calls.push([...passages]);
        if (calls.length === 1) return passages.map((_, index) => index);
        if (mode === 'failed') throw new Error('window model failed');
        if (mode === 'malformed') return [1];
        if (mode === 'timed_out') return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        return passages.map(text => text.includes(answer) ? 100 : 0);
      },
    };
    const input = {
      ...packInput(reranker, [], undefined, () => ({
        sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
        chunks: original, candidatePassages: candidates,
      })),
      maxResults: 4, maxCharsPerCandidate: 600, rerankTimers: fake,
    };
    return { input, calls, fake };
  }

  test('finds a missed answering sentence, keeps item order, and only windows the top three kept long items', async () => {
    const { input, calls } = windowInput();
    const detail = await buildEvidencePackDetailed(input);
    expect(packIds(detail)).toEqual(['doc-9', 'doc-8', 'doc-7', 'doc-6']);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.join(' ')).not.toContain(answer);
    expect(calls[1]!.filter(text => text.includes(answer))).toHaveLength(3);
    for (const candidate of detail.pack.candidates.slice(0, 3)) {
      expect(candidate.chunks[0]).toContain(answer);
      expect(candidate.chunks.slice(1)).toEqual(original);
      expect(candidate.chunks.join('').length).toBeLessThanOrEqual(600);
    }
    expect(detail.pack.candidates[3]!.chunks).toEqual(original);
    expect(detail.rerank).toMatchObject({ windowOutcome: 'applied', windowItems: 3, windowsScored: calls[1]!.length, windowElapsedMs: 0 });
    expect(JSON.stringify(detail.rerank)).not.toContain(answer);
  });

  test('a best window the item already shows whole is not seated twice', async () => {
    const { input } = windowInput();
    const shown = ['Opening passage. ' + answer, 'Existing supporting passage.'];
    input.contentProviders[CORPUS] = { async fetchLocalContent() {
      return { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: shown, candidatePassages: [answer] };
    } };
    const detail = await buildEvidencePackDetailed(input);
    expect(detail.rerank).toMatchObject({ windowOutcome: 'applied' });
    for (const candidate of detail.pack.candidates) expect(candidate.chunks).toEqual(shown);
  });

  test('a small budget gets windows that fit it, so the winning sentence is seated whole', async () => {
    const { input, calls } = windowInput();
    const detail = await buildEvidencePackDetailed({ ...input, maxCharsPerCandidate: 400 });
    expect(calls[1]!.every(text => text.length <= 400)).toBe(true);
    expect(detail.pack.candidates[0]!.chunks[0]).toContain(answer);
  });

  test('a winning window over the byte budget is not seated, and the passages stay', async () => {
    const { input } = windowInput();
    const wide = 'é'.repeat(250) + ' ' + answer;
    input.contentProviders[CORPUS] = { async fetchLocalContent() {
      return { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: original, candidatePassages: [wide] };
    } };
    const detail = await buildEvidencePackDetailed({ ...input, maxCharsPerCandidate: 400 });
    for (const candidate of detail.pack.candidates) expect(candidate.chunks).toEqual(original);
  });

  for (const mode of ['failed', 'timed_out', 'malformed'] as const) {
    test(`window ${mode} preserves all passages exactly`, async () => {
      const { input, fake, calls } = windowInput(mode);
      const pending = buildEvidencePackDetailed(input);
      await flushMicrotasks(100);
      expect(calls).toHaveLength(2);
      if (mode === 'timed_out') await fake.clock.advance(DEFAULT_RERANK_TIMEOUT_MS);
      const detail = await pending;
      expect(packIds(detail)).toEqual(['doc-9', 'doc-8', 'doc-7', 'doc-6']);
      for (const candidate of detail.pack.candidates) expect(candidate.chunks).toEqual(original);
      expect(detail.rerank).toMatchObject({ windowOutcome: mode === 'malformed' ? 'failed' : mode, windowItems: 3, windowsScored: 0,
        windowElapsedMs: mode === 'timed_out' ? DEFAULT_RERANK_TIMEOUT_MS : 0 });
      expect(fake.clock.pendingTimers()).toBe(0);
    });
  }

  test('does not window after an item-stage failure', async () => {
    const { input, calls } = windowInput();
    input.reranker!.score = async ({ passages }) => { calls.push([...passages]); throw new Error('item failure'); };
    const detail = await buildEvidencePackDetailed(input);
    expect(calls).toHaveLength(1);
    expect(detail.rerank).toMatchObject({ outcome: 'failed', windowOutcome: 'skipped', windowsScored: 0, windowItems: 0 });
    for (const candidate of detail.pack.candidates) expect(candidate.chunks).toEqual(original);
  });

  test('an item-stage timeout skips window scoring', async () => {
    const { input, calls, fake } = windowInput();
    input.reranker!.score = async ({ passages }) => {
      calls.push([...passages]);
      return new Promise(() => {});
    };
    const pending = buildEvidencePackDetailed(input);
    await flushMicrotasks(100);
    await fake.clock.advance(DEFAULT_RERANK_TIMEOUT_MS);
    const detail = await pending;
    expect(calls).toHaveLength(1);
    expect(detail.rerank).toMatchObject({ outcome: 'timed_out', windowOutcome: 'skipped', windowsScored: 0, windowItems: 0 });
    for (const candidate of detail.pack.candidates) expect(candidate.chunks).toEqual(original);
  });

  test('windows are scored against the question even when retrieval uses a search query', async () => {
    const { input } = windowInput();
    const questions: string[] = [];
    const score = input.reranker!.score;
    input.reranker!.score = request => { questions.push(request.query); return score(request); };
    await buildEvidencePackDetailed({ ...input, searchQuery: 'invoice' });
    expect(questions).toEqual(['invoice', input.question]);
  });

  test('candidate passages have no effect without a reranker and are never requested', async () => {
    const now = () => new Date('2026-01-01T00:00:00Z');
    const baseline = await buildEvidencePackDetailed({ ...packInput(undefined, []), now });
    const input = { ...packInput(undefined, []), now };
    const provider = input.contentProviders[CORPUS]!;
    input.contentProviders[CORPUS] = { async fetchLocalContent(request) {
      expect(request).not.toHaveProperty('candidatePassages');
      return { ...(await provider.fetchLocalContent(request))!, candidatePassages: candidates };
    } };
    const result = await buildEvidencePackDetailed(input);
    expect(JSON.stringify(result.pack)).toBe(JSON.stringify(baseline.pack));
    expect(result.rerank).toBeUndefined();
  });

  test('Private windows use the local reranker and remain local for the analyst and escalation', async () => {
    const { input, calls } = windowInput();
    const originalProvider = input.contentProviders[CORPUS]!;
    input.contentProviders[CORPUS] = { async fetchLocalContent(request) {
      const block = await originalProvider.fetchLocalContent(request);
      return { ...block!, sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }) };
    } };
    const detail = await buildEvidencePackDetailed(input);
    expect(calls[1]!.join(' ')).toContain(answer);
    expect(detail.encounteredSecureLocal).toBe(true);
    let localCalls = 0;
    await createAnalyst({ async complete(request) {
      expect(request.localOnly).toBe(true);
      expect(request.prompt).toContain(answer);
      localCalls++;
      return { modelId: 'fixture', text: JSON.stringify({ answer: 'No answer.', citations: [], unanswered: [], sufficient: false }) };
    } }).analyze(detail.pack, { localOnly: false });
    expect(localCalls).toBeGreaterThan(0);
    const escalation = JSON.stringify(redactPackForEscalation(detail.pack));
    expect(escalation).not.toContain(answer);
    expect(escalation).not.toContain(candidates[0]!);
    for (const candidate of detail.pack.candidates) expect(candidate).not.toHaveProperty('candidatePassages');
    const excluded = await buildEvidencePackDetailed({ ...input, excludeSecureSensitivity: true });
    expect(excluded.pack.candidates).toHaveLength(0);
    expect(calls).toHaveLength(2);
  });
});
