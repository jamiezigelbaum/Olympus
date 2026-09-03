import { describe, expect, test } from 'bun:test';
import {
  buildEvidencePackDetailed,
  type LocalContentBlock,
  type LocalContentProvider,
  type LocalContentProviderMap,
} from '../src/core/evidence-pack.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import type {
  SourceIndexCorpusSearchAdapter,
  SourceIndexRouterAdapterMap,
  SourceIndexSearchContext,
} from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';

const CORPUS = 'internal.dropbox.files';
const CHAT_CORPUS = 'internal.chat.messages';
const NO_ADAPTER_CORPUS = 'internal.dropbox.other';
const QUESTION = 'How do the 2024 and 2025 lab results compare?';

function registry() {
  return buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId: CORPUS, family: 'file', trustDomain: 'internal' }),
    defineSourceIndexCorpus({ corpusId: NO_ADAPTER_CORPUS, family: 'file', trustDomain: 'internal' }),
  ]);
}

// Per-query fixture adapter: returns different candidates per query and
// records every query the router sent it, with one lane audit per run.
function adapterByQuery(idsByQuery: Record<string, string[]>, calls: string[]): SourceIndexCorpusSearchAdapter {
  return (request) => {
    calls.push(request.query);
    const ids = idsByQuery[request.query] ?? [];
    return {
      hits: ids.map((id, index) => ({
        sourceItem: { family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: id, localItemId: id },
        provenance: {
          sourceItem: { family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: id, localItemId: id },
          citation: { title: id },
        },
        score: 1 - index * 0.1,
        rawExposed: false as const,
      })),
      latencyMs: 1,
      laneAudits: [
        {
          laneName: `keyword:${request.query}`,
          laneType: 'keyword' as const,
          candidateCount: ids.length,
          returnedCount: ids.length,
          localOnly: true,
          rawExposed: false,
        },
      ],
      rawExposed: false as const,
    };
  };
}

// Every hit at rank 1 of its query, all carrying one adapter-local score, so a
// test can hold the ranking fixed and vary only the scale.
function scoredAdapter(idsByQuery: Record<string, string[]>, score: number): SourceIndexCorpusSearchAdapter {
  return (request) => {
    const ids = idsByQuery[request.query] ?? [];
    return {
      hits: ids.map((id) => ({
        sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: id, localItemId: id },
        provenance: {
          sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: id, localItemId: id },
          citation: { title: id },
        },
        score,
        rawExposed: false as const,
      })),
      latencyMs: 1,
      laneAudits: [],
      rawExposed: false as const,
    };
  };
}

function provider(blocks: Record<string, LocalContentBlock | undefined>): LocalContentProvider {
  return {
    async fetchLocalContent(request) {
      return blocks[request.provenance.sourceItem.providerItemId];
    },
  };
}

function internalBlock(chunk: string): LocalContentBlock {
  return { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: [chunk] };
}

const allowAll: SourceIndexSearchContext = { allowedTrustDomains: ['internal', 'secure_local', 'public_safe'] };

function contentProviders(): LocalContentProviderMap {
  return {
    [CORPUS]: provider({
      'doc-a': internalBlock('2024 LDL 110 mg/dL'),
      'doc-b': internalBlock('2025 LDL 96 mg/dL'),
    }),
  } as LocalContentProviderMap;
}

describe('buildEvidencePackDetailed multi-query expansion', () => {
  test('fuses candidates found by different planned queries and dedupes shared hits', async () => {
    const calls: string[] = [];
    const detail = await buildEvidencePackDetailed({
      question: QUESTION,
      queryPlanner: async () => ['2025 lab results'],
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery(
          {
            [QUESTION]: ['doc-a'],
            '2025 lab results': ['doc-b', 'doc-a'], // doc-a found by BOTH queries
          },
          calls,
        ),
      } as SourceIndexRouterAdapterMap,
      contentProviders: contentProviders(),
    });

    expect(calls).toEqual([QUESTION, '2025 lab results']);
    const ids = detail.pack.candidates.map((c) => c.provenance.sourceItem.providerItemId);
    expect([...ids].sort()).toEqual(['doc-a', 'doc-b']); // both present, doc-a once
    // doc-a ranked in both lanes, so RRF puts it first; content is fetched for both.
    expect(ids[0]).toBe('doc-a');
    expect(detail.pack.candidates.every((c) => c.chunks.length === 1)).toBe(true);
  });

  test('no planner = exactly one search with the literal query (unchanged behavior)', async () => {
    const calls: string[] = [];
    const detail = await buildEvidencePackDetailed({
      question: QUESTION,
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery({ [QUESTION]: ['doc-a'], '2025 lab results': ['doc-b'] }, calls),
      } as SourceIndexRouterAdapterMap,
      contentProviders: contentProviders(),
    });

    expect(calls).toEqual([QUESTION]);
    expect(detail.pack.candidates.map((c) => c.provenance.sourceItem.providerItemId)).toEqual(['doc-a']);
    expect(detail.laneAudits).toHaveLength(1);
  });

  // RRF exists so incomparable adapter scores are never compared. The cross-
  // query tie-break reintroduced the comparison at the moment the pack is cut:
  // adapter scores carry no scale contract, so a chat corpus emitting sub-lane
  // RRF scores (~0.016) sorted below every bm25-derived one (~8) no matter how
  // relevant it was, and nothing in coverage recorded the loss.
  test('a cross-query tie is broken without comparing adapter scores across corpora', async () => {
    const orderFor = async (chatScore: number, fileScore: number): Promise<string[]> => {
      const detail = await buildEvidencePackDetailed({
        question: QUESTION,
        queryPlanner: async () => ['2025 lab results'],
        maxResults: 10,
        searchContext: allowAll,
        registry: buildSourceIndexCorpusRegistry([
          defineSourceIndexCorpus({ corpusId: CORPUS, family: 'file', trustDomain: 'internal' }),
          defineSourceIndexCorpus({ corpusId: CHAT_CORPUS, family: 'chat', trustDomain: 'internal' }),
        ]),
        adapters: {
          // Each hit is rank 1 of exactly one query lane, so every candidate
          // carries the identical RRF score and the tie-break decides the pack.
          [CHAT_CORPUS]: scoredAdapter({ [QUESTION]: ['chat-1'] }, chatScore),
          [CORPUS]: scoredAdapter({ '2025 lab results': ['doc-a'] }, fileScore),
        } as SourceIndexRouterAdapterMap,
        contentProviders: {
          [CORPUS]: provider({ 'doc-a': internalBlock('2025 LDL 96 mg/dL') }),
          [CHAT_CORPUS]: provider({ 'chat-1': internalBlock('the 2025 panel came back fine') }),
        } as LocalContentProviderMap,
      });
      return detail.pack.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId);
    };

    const chatScoredLow = await orderFor(0.0164, 8);
    const chatScoredHigh = await orderFor(8, 0.0164);

    expect(chatScoredLow).toHaveLength(2);
    expect(chatScoredHigh).toEqual(chatScoredLow);
  });

  test('recent/latest questions order evidence by citation date before rank', async () => {
    const detail = await buildEvidencePackDetailed({
      question: 'Analyze my recent lab results.',
      searchQuery: 'lab results',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: () => ({
          hits: [
            {
              sourceItem: { family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: 'old-lab', localItemId: 'old-lab' },
              provenance: {
                sourceItem: { family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: 'old-lab', localItemId: 'old-lab' },
                citation: { title: 'old-lab', authoredAt: '2014-10-23T00:00:00.000Z' },
              },
              score: 0.99,
              rawExposed: false,
            },
            {
              sourceItem: { family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: 'new-lab', localItemId: 'new-lab' },
              provenance: {
                sourceItem: { family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: 'new-lab', localItemId: 'new-lab' },
                citation: { title: 'new-lab', authoredAt: '2026-04-17T00:00:00.000Z' },
              },
              score: 0.1,
              rawExposed: false,
            },
          ],
          latencyMs: 1,
          laneAudits: [],
          rawExposed: false,
        }),
      } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [CORPUS]: provider({
          'old-lab': internalBlock('2014 sodium panel'),
          'new-lab': internalBlock('2026 ApoB lipid panel'),
        }),
      },
    });

    expect(detail.pack.candidates.map((c) => c.provenance.sourceItem.providerItemId)).toEqual([
      'new-lab',
      'old-lab',
    ]);
  });

  test('caps at 3 queries total and dedupes planned queries against the base query', async () => {
    const calls: string[] = [];
    await buildEvidencePackDetailed({
      question: QUESTION,
      queryPlanner: async () => [QUESTION, ' q2 ', 'q2', 'q3', 'q4'],
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [CORPUS]: adapterByQuery({}, calls) } as SourceIndexRouterAdapterMap,
      contentProviders: contentProviders(),
    });

    expect(calls).toEqual([QUESTION, 'q2', 'q3']);
  });

  test('searchQuery stays the first (literal) query when a planner is present', async () => {
    const calls: string[] = [];
    await buildEvidencePackDetailed({
      question: QUESTION,
      searchQuery: 'lab results',
      queryPlanner: async () => ['2025 lab results'],
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [CORPUS]: adapterByQuery({}, calls) } as SourceIndexRouterAdapterMap,
      contentProviders: contentProviders(),
    });

    expect(calls).toEqual(['lab results', '2025 lab results']);
  });

  test('concatenates lane audits across runs; coverage comes from the first run', async () => {
    const detail = await buildEvidencePackDetailed({
      question: QUESTION,
      queryPlanner: async () => ['2025 lab results'],
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery({ [QUESTION]: ['doc-a'], '2025 lab results': ['doc-b'] }, []),
      } as SourceIndexRouterAdapterMap,
      contentProviders: contentProviders(),
    });

    expect(detail.laneAudits.map((audit) => audit.laneName)).toEqual([
      `keyword:${QUESTION}`,
      'keyword:2025 lab results',
    ]);
    // Coverage is from the first run only — searched/skipped corpora are not
    // duplicated per query.
    expect(detail.pack.coverage.searchedCorpora).toEqual([CORPUS]);
    expect(detail.skippedCorpora).toHaveLength(1);
    expect(detail.skippedCorpora[0]).toMatchObject({ corpusId: NO_ADAPTER_CORPUS, reason: 'no_adapter' });
  });

  test('a throwing planner fails open to the single literal query', async () => {
    const calls: string[] = [];
    const detail = await buildEvidencePackDetailed({
      question: QUESTION,
      queryPlanner: async () => {
        throw new Error('planner lane down');
      },
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery({ [QUESTION]: ['doc-a'] }, calls),
      } as SourceIndexRouterAdapterMap,
      contentProviders: contentProviders(),
    });

    expect(calls).toEqual([QUESTION]);
    expect(detail.pack.candidates.map((c) => c.provenance.sourceItem.providerItemId)).toEqual(['doc-a']);
  });

  test('fused results respect maxResults', async () => {
    // maxResults 2 with a 1-hit literal run: thin enough to expand, so fusion
    // still happens and its cap is what this test is about.
    const detail = await buildEvidencePackDetailed({
      question: QUESTION,
      queryPlanner: async () => ['2025 lab results'],
      maxResults: 2,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery(
          { [QUESTION]: ['doc-a'], '2025 lab results': ['doc-b', 'doc-c'] },
          [],
        ),
      } as SourceIndexRouterAdapterMap,
      contentProviders: contentProviders(),
    });

    expect(detail.pack.candidates).toHaveLength(2);
  });
});
