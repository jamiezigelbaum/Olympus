// Unified retrieval honesty: no lane leaves a unified answer silently, and a
// released citation locates its supporting span inside the item.
//
// The two defects these tests pin, both measured 2026-07-28:
//
//   1. A lane that drops out of the fan-out is invisible to the caller in every
//      case except a first-run corpus timeout. A hybrid retry whose corpora blew
//      the deadline, an expansion query whose corpus timed out, and a
//      semantic-capable corpus served keyword-only all produced a
//      keyword-shaped answer with nothing in the result saying so. A caller
//      could not tell "keyword-only because that is all there was" from
//      "semantic timed out".
//   2. Citations stopped at item granularity. `SourceIndexProvenance.chunk` has
//      existed on the frozen provenance shape the whole time and no retrieval
//      lane ever filled it, so nothing downstream could say WHERE in a
//      multi-chunk item the support lives.
//
// Every assertion here is counts-only or offsets-only: no chunk text, no path.

import { describe, expect, test } from 'bun:test';
import type {
  Analyst,
  AnalystResult,
  EvidencePack,
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import type { LocalContentProviderMap } from '../src/core/evidence-pack.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import {
  routeSourceIndexSearch,
  type SourceIndexCorpusSearchAdapter,
  type SourceIndexCorpusSearchResponse,
  type SourceIndexRouterAdapterMap,
} from '../src/core/source-index/router.ts';
import { mergeRetrievalDegradations } from '../src/core/source-index/retrieval.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';
import type { SourceIndexAnswerRequest } from '../src/workers/source-index/answer-types.ts';
import type {
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

const CORPUS = 'secure_local.fake.files';
const ACCOUNT = 'personal';
const EMBED_DIMENSION = 8;

// --- Fixtures ----------------------------------------------------------------

function identityFor(id: string) {
  return {
    family: 'file' as const,
    provider: 'fake',
    accountScope: ACCOUNT,
    providerItemId: id,
    providerFileId: id,
    localItemId: `${ACCOUNT}:${id}`,
  };
}

function hitFor(id: string) {
  return {
    sourceItem: identityFor(id),
    provenance: { sourceItem: identityFor(id), citation: { title: `${id}.md` } },
    score: 1,
    rawExposed: false as const,
  };
}

function keywordAdapter(ids: readonly string[]): SourceIndexCorpusSearchAdapter {
  return (request) => ({
    hits: ids.slice(0, request.maxResults).map(hitFor),
    latencyMs: 1,
    laneAudits: [{
      laneName: `${request.corpus.corpusId}:fts`,
      laneType: 'keyword' as const,
      candidateCount: ids.length,
      returnedCount: ids.length,
      localOnly: true,
      rawExposed: false,
    }],
    rawExposed: false as const,
  });
}

// An adapter that never settles inside the deadline. Deliberately resolves
// eventually so the test process holds no dangling timer.
function stallingAdapter(delayMs: number): SourceIndexCorpusSearchAdapter {
  return async (request): Promise<SourceIndexCorpusSearchResponse> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { hits: [hitFor('late')], latencyMs: delayMs, rawExposed: false, ...{ corpus: undefined } as object } as SourceIndexCorpusSearchResponse;
  };
}

function contentProviders(ids: readonly string[]): LocalContentProviderMap {
  const provider = {
    async fetchLocalContent() {
      return {
        sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
        chunks: ['bounded evidence text'],
      };
    },
  };
  return Object.fromEntries(ids.map((id) => [id, provider])) as LocalContentProviderMap;
}

function citingFirstCandidate(): Analyst {
  return {
    async analyze(pack: EvidencePack): Promise<AnalystResult> {
      return {
        answer: 'Answered from the pack.',
        citations: pack.candidates.length > 0
          ? [{ provenance: pack.candidates[0]!.provenance, claim: 'claim' }]
          : [],
        unanswered: [],
      };
    },
  };
}

async function withLaneTimeout<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS;
  process.env.OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS = String(ms);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS;
    else process.env.OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS = previous;
  }
}

// --- Degradation markers -----------------------------------------------------

describe('unified retrieval reports every dropped lane', () => {
  // RED BEFORE: the router reported a corpus timeout in skippedCorpora but
  // carried no lane-shaped degradation, so nothing downstream could merge one
  // fan-out's losses with another's.
  test('router marks a corpus that blew the deadline', async () => {
    const registry = buildSourceIndexCorpusRegistry([
      defineSourceIndexCorpus({ corpusId: 'internal.fast.docs', family: 'file', trustDomain: 'internal' }),
      defineSourceIndexCorpus({ corpusId: 'internal.slow.docs', family: 'file', trustDomain: 'internal' }),
    ]);
    const result = await routeSourceIndexSearch({
      registry,
      adapters: {
        'internal.fast.docs': keywordAdapter(['doc-1']),
        'internal.slow.docs': stallingAdapter(60),
      },
      request: { query: 'q', maxResults: 3, context: { allowedTrustDomains: ['internal'] } },
      laneTimeoutMs: 10,
    });

    expect(result.degradations).toEqual([
      expect.objectContaining({
        laneName: 'internal.slow.docs',
        reason: 'lane_timeout',
        occurrences: 1,
      }),
    ]);
  });

  // RED BEFORE: `retrieval_mode` defaults to keyword everywhere, so a
  // hybrid-capable corpus routinely served keyword-only while its
  // retrieval_mode_enforcement audit read `backend: hybrid, health: ready`.
  // Nothing said the semantic lane had not run.
  test('router marks a servable semantic lane that was not run', async () => {
    const corpus = defineSourceIndexCorpus({
      corpusId: 'internal.notes.docs',
      family: 'note',
      trustDomain: 'internal',
      activationMode: 'hybrid_primary',
    });
    const adapter = keywordAdapter(['doc-1']);
    adapter.hybridAvailability = () => ({ servable: true, modelId: 'm1', backend: 'local' });

    const result = await routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([corpus]),
      adapters: { 'internal.notes.docs': adapter },
      request: { query: 'q', maxResults: 3, context: { allowedTrustDomains: ['internal'] } },
      laneTimeoutMs: 0,
    });

    expect(result.degradations).toEqual([
      expect.objectContaining({
        laneName: 'internal.notes.docs:semantic',
        laneType: 'semantic',
        reason: 'semantic_lane_not_run',
        occurrences: 1,
      }),
    ]);
  });

  test('router keeps an adapter-level semantic timeout loud even when hybrid fusion returned keyword hits', async () => {
    const corpusId = 'internal.notes.docs';
    const keyword = keywordAdapter(['doc-1']);
    const adapter: SourceIndexCorpusSearchAdapter = async (request) => {
      const response = await keyword(request);
      return {
        ...response,
        laneAudits: [
          {
            laneName: `${corpusId}:semantic`,
            laneType: 'semantic',
            candidateCount: 0,
            returnedCount: 0,
            skippedReason: 'vector_scan_deadline_exceeded',
            localOnly: true,
            rawExposed: false,
          },
          {
            laneName: `${corpusId}:hybrid`,
            laneType: 'hybrid',
            candidateCount: 1,
            returnedCount: 1,
            localOnly: true,
            rawExposed: false,
          },
        ],
      };
    };
    adapter.hybridAvailability = () => ({ servable: true, modelId: 'm1', backend: 'local' });

    const result = await routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({
        corpusId,
        family: 'note',
        trustDomain: 'internal',
        activationMode: 'hybrid_primary',
      })]),
      adapters: { [corpusId]: adapter },
      request: {
        query: 'q',
        maxResults: 3,
        context: { allowedTrustDomains: ['internal'] },
      },
      laneTimeoutMs: 0,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.degradations).toContainEqual({
      laneName: `${corpusId}:semantic`,
      laneType: 'semantic',
      reason: 'semantic_lane_skipped',
      detail: 'vector_scan_deadline_exceeded',
      occurrences: 1,
    });
  });

  test('a default hybrid lane timeout is loud in the answer', async () => {
    const lanes = (request: SourceIndexAnswerRequest) => ({
      registry: buildSourceIndexCorpusRegistry([
        defineSourceIndexCorpus({ corpusId: CORPUS, family: 'file', trustDomain: 'internal' }),
      ]),
      adapters: {
        // The product default requests hybrid directly. That lane blows the
        // deadline and must remain visible in the answer audit.
        [CORPUS]: request.retrieval_mode === 'hybrid'
          ? stallingAdapter(80)
          : keywordAdapter([]),
      } as SourceIndexRouterAdapterMap,
      contentProviders: contentProviders([CORPUS]),
    });
    const handler = createAnalystSourceIndexAnswerHandler({ analyst: citingFirstCandidate(), lanes });

    const result = await withLaneTimeout(10, () => handler.answer({ question: 'what did the retro decide?' }));

    expect(result.audit.retrieval_degradations).toEqual([
      expect.objectContaining({ lane_name: CORPUS, reason: 'lane_timeout' }),
    ]);
    expect(result.audit.skipped_corpora).toEqual(expect.arrayContaining([
      expect.objectContaining({ corpus_id: CORPUS, reason: 'lane_timeout' }),
    ]));
  });

  test('a self-heal rebuild keeps the default hybrid retrieval mode', async () => {
    const retrievalModes: string[] = [];
    const lanes = (request: SourceIndexAnswerRequest) => {
      retrievalModes.push(request.retrieval_mode ?? 'missing');
      return {
      registry: buildSourceIndexCorpusRegistry([
        defineSourceIndexCorpus({ corpusId: CORPUS, family: 'file', trustDomain: 'internal' }),
      ]),
      adapters: {
        [CORPUS]: request.retrieval_mode === 'hybrid'
          ? keywordAdapter(['hybrid-only'])
          : keywordAdapter([]),
      } as SourceIndexRouterAdapterMap,
      contentProviders: contentProviders([CORPUS]),
      };
    };
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: citingFirstCandidate(),
      lanes,
      selfHeal: async () => ({ healed: true, audit: { attempted: true, outcome: 'healed' } }),
    });

    const result = await handler.answer({ question: 'what did the retro decide?' });

    expect(result.evidence).toHaveLength(1);
    expect(result.audit.self_heal).toMatchObject({ outcome: 'healed' });
    expect(retrievalModes).toEqual(['hybrid']);
  });

  // RED BEFORE: runRoutedSearches returned literalRun.skippedCorpora, so a
  // corpus that only timed out on a planner expansion query vanished.
  test('a planner expansion whose lane timed out is loud in the answer', async () => {
    let call = 0;
    const adapter: SourceIndexCorpusSearchAdapter = async (request) => {
      call += 1;
      // Literal run answers thin (1 hit < maxResults) so the planner is awaited;
      // the expansion run stalls past the deadline.
      if (call === 1) return keywordAdapter(['doc-1'])(request);
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { hits: [], latencyMs: 80, rawExposed: false };
    };
    const lanes = () => ({
      registry: buildSourceIndexCorpusRegistry([
        defineSourceIndexCorpus({ corpusId: CORPUS, family: 'file', trustDomain: 'internal' }),
      ]),
      adapters: { [CORPUS]: adapter } as SourceIndexRouterAdapterMap,
      contentProviders: contentProviders([CORPUS]),
    });
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: citingFirstCandidate(),
      lanes,
      queryPlanner: async () => ['a differently worded question'],
    });

    const result = await withLaneTimeout(10, () => handler.answer({
      question: 'what did the retro decide?',
      max_results: 3,
    }));

    expect(result.audit.retrieval_degradations).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane_name: CORPUS, reason: 'lane_timeout' }),
    ]));
  });

  // The distinction the owner asked for, stated as a test: a corpus that never
  // could run a semantic lane produces NO semantic degradation, so
  // "keyword-only because that is all there was" and "semantic timed out" are
  // different observable states rather than the same silence.
  test('a lexical-only corpus reports no semantic degradation', async () => {
    const result = await routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([
        defineSourceIndexCorpus({ corpusId: 'internal.plain.docs', family: 'file', trustDomain: 'internal' }),
      ]),
      adapters: { 'internal.plain.docs': keywordAdapter(['doc-1']) },
      request: { query: 'q', maxResults: 3, context: { allowedTrustDomains: ['internal'] } },
      laneTimeoutMs: 0,
    });

    expect(result.degradations).toEqual([]);
  });

  // A corpus that declares a semantic lane it cannot currently serve is a
  // different state again: the lane is missing for a reason the deployment can
  // fix, and the reason token travels with the marker.
  test('an unservable semantic lane names why it could not run', async () => {
    const adapter = keywordAdapter(['doc-1']);
    adapter.hybridAvailability = () => ({ servable: false, reason: 'no_current_embedding_artifacts' });

    const result = await routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({
        corpusId: 'internal.notes.docs',
        family: 'note',
        trustDomain: 'internal',
        activationMode: 'hybrid_primary',
      })]),
      adapters: { 'internal.notes.docs': adapter },
      request: { query: 'q', maxResults: 3, context: { allowedTrustDomains: ['internal'] } },
      laneTimeoutMs: 0,
    });

    expect(result.degradations).toEqual([{
      laneName: 'internal.notes.docs:semantic',
      laneType: 'semantic',
      reason: 'semantic_lane_unservable',
      detail: 'no_current_embedding_artifacts',
      occurrences: 1,
    }]);
  });

  // Merging is the operation every consumer performs, so it has to collapse
  // rather than accumulate duplicates: the same lane lost on two fan-outs of
  // one answer is one problem seen twice, not two problems.
  test('the same lane lost on two runs merges into one marker with a count', () => {
    const merged = mergeRetrievalDegradations(
      [{ laneName: 'a', laneType: 'semantic', reason: 'lane_timeout', occurrences: 1 }],
      [
        { laneName: 'a', laneType: 'semantic', reason: 'lane_timeout', occurrences: 1 },
        { laneName: 'b', laneType: 'keyword', reason: 'lane_no_adapter', occurrences: 1 },
      ],
    );

    expect(merged).toEqual([
      { laneName: 'a', laneType: 'semantic', reason: 'lane_timeout', occurrences: 2 },
      { laneName: 'b', laneType: 'keyword', reason: 'lane_no_adapter', occurrences: 1 },
    ]);
  });

  // The deadline is a per-call quantity, not a process-wide one. Before this it
  // could only be set through an env var, which a single process serving
  // several callers cannot vary.
  test('the handler sets its own lane deadline without touching the environment', async () => {
    const lanes = () => ({
      registry: buildSourceIndexCorpusRegistry([
        defineSourceIndexCorpus({ corpusId: CORPUS, family: 'file', trustDomain: 'internal' }),
      ]),
      adapters: { [CORPUS]: stallingAdapter(80) } as SourceIndexRouterAdapterMap,
      contentProviders: contentProviders([CORPUS]),
    });
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: citingFirstCandidate(),
      lanes,
      laneTimeoutMs: 10,
    });

    expect(process.env.OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS).toBeUndefined();
    const result = await handler.answer({ question: 'what did the retro decide?' });

    expect(result.audit.retrieval_degradations).toEqual([
      expect.objectContaining({ lane_name: CORPUS, reason: 'lane_timeout' }),
    ]);
  });
});

// --- Offset citations --------------------------------------------------------

function longDocConnector(text: string): SourceConnector {
  const item: RawItem = {
    identity: {
      family: 'file',
      provider: 'fake',
      accountScope: ACCOUNT,
      providerItemId: 'id:long',
      providerFileId: 'id:long',
      localItemId: `${ACCOUNT}:id:long`,
      sourceVersion: 'rev-1',
    },
    mimeType: 'text/markdown',
    content: { kind: 'text', text },
    metadata: Object.freeze({ name: 'long.md', locatorUri: '/Approved/long.md' }),
    fetchedAt: '2026-07-28T10:00:00.000Z',
  };
  return {
    id: 'fake',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: [item], done: true };
      })();
    },
    async fetchItem(): Promise<RawItem> {
      return item;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}

function fakeEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'fake-test-embeddings',
    modelId: 'fake-embed-v1',
    dimension: EMBED_DIMENSION,
    configHash: 'fake-test-embeddings-config',
    epochId: `local:fake-test-embeddings:fake-embed-v1:${EMBED_DIMENSION}`,
    backend: 'local',
    async embed(inputs: readonly SourceEmbeddingInput[]): Promise<number[][]> {
      return inputs.map((input) => {
        const vector = new Array<number>(EMBED_DIMENSION).fill(0);
        // Deterministic and content-sensitive: the marker token dominates.
        vector[0] = input.text.includes('lancedb') || input.text.includes('LanceDB') ? 1 : 0.1;
        vector[1] = 0.2;
        return vector;
      });
    },
  };
}

describe('unified retrieval citations locate a span inside the item', () => {
  // RED BEFORE: `SourceIndexProvenance.chunk` was never populated by any
  // retrieval lane, so the released evidence could name the item and nothing
  // finer. A four-chunk document cited the whole document.
  test('a keyword hit cites the chunk and character offsets that matched', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS,
      family: 'file',
      trustDomain: 'secure_local',
    });
    // Three chunks of 4,000 chars each; the marker sits deep in chunk 2 so a
    // correct span cannot be produced by defaulting to chunk 0.
    const filler = 'alpha beta gamma delta '.repeat(360); // ~8,280 chars
    const text = `${filler.slice(0, 8_400)}the retro adopted lancedb for unified search. ${filler.slice(0, 2_000)}`;
    await store.syncFromConnector(longDocConnector(text), { fetchContent: true });

    const registry = buildSourceIndexCorpusRegistry([defineConnectorCorpus({
      corpusId: store.corpusId,
      family: store.family,
      trustDomain: store.trustDomain,
    })]);
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: citingFirstCandidate(),
      lanes: () => ({
        registry,
        adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store }) } as SourceIndexRouterAdapterMap,
        contentProviders: { [store.corpusId]: createConnectorStoreContentProvider({ store }) } as LocalContentProviderMap,
      }),
    });

    const result = await handler.answer({
      question: 'what did the retro adopt? lancedb',
      include_secure_local: true,
      include_secure_local_content: true,
    });

    expect(result.evidence).toHaveLength(1);
    const span = result.evidence[0]!.citation_span;
    // Exact offsets, not shape matchers. The fixture text is deterministic, so
    // every number here is checkable by hand: the first query term present in
    // the item ("the") starts at item offset 8,280, which is 280 into chunk 2
    // because chunks 0 and 1 are 4,000 characters each.
    //
    // (Asserted as concrete values on purpose — `toMatchObject` with
    // `expect.any(Number)` mutates the received object under bun 1.3.14, so a
    // later read of the same object sees the matchers instead of the data.)
    expect(span).toEqual({
      chunk_index: 2,
      chunk_id: span!.chunk_id,
      char_start: 280,
      char_end: 283,
      item_char_start: 8_280,
      item_char_end: 8_283,
      chunk_chars: 2_326,
      lane: 'keyword',
    });
    expect(span!.chunk_id.length).toBeGreaterThan(0);
    expect(span!.item_char_start - span!.char_start).toBe(4_000 * 2);
    // Offsets travel alone. The bounded text they point at stays behind the
    // membrane.
    expect(JSON.stringify(result.evidence)).not.toContain('lancedb');
    store.close();
  });

  // The semantic lane knows which chunk won on cosine but has no sub-chunk
  // signal, so it must claim the whole chunk rather than invent a tighter span.
  test('a semantic hit cites the whole winning chunk, honestly', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS,
      family: 'file',
      trustDomain: 'secure_local',
    });
    const filler = 'alpha beta gamma delta '.repeat(360);
    const text = `${filler.slice(0, 4_200)}the retro adopted lancedb. ${filler.slice(0, 1_000)}`;
    await store.syncFromConnector(longDocConnector(text), { fetchContent: true });
    const provider = fakeEmbeddingProvider();
    await store.embedChunks({ provider });

    const rows = await store.vectorSearchItemsWithScores('lancedb', provider, 5, ACCOUNT);

    expect(rows).toHaveLength(1);
    const chunk = rows[0]!.chunk!;
    expect(chunk.chunkIndex).toBe(1);
    expect(chunk.lane).toBe('semantic');
    // Whole chunk, start to end: a cosine scores the chunk, so that is the
    // largest claim it can make and the smallest one it must not shrink below.
    expect(chunk.charStart).toBe(0);
    expect(chunk.charEnd).toBe(chunk.chunkChars);
    expect(chunk.itemCharStart).toBe(4_000);
    expect(chunk.itemCharEnd).toBe(4_000 + chunk.chunkChars);
    store.close();
  });
});
