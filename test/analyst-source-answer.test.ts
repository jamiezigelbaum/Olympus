// Lane B: the analyst-backed source_answer handler. Proves the contracts path
// (route -> pack -> Analyst -> release gate) produces the existing Castor-safe
// wire shape with honest audits, and that the trust postures hold: secure_local
// content releases only when explicitly requested, escalations never release
// content, and raw chunk text never reaches the serialized result.

import { describe, expect, test } from 'bun:test';
import type {
  Analyst,
  AnalystOptions,
  AnalystResult,
  EvidencePack,
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import type { LocalContentProviderMap, LocalContentRequest } from '../src/core/evidence-pack.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import {
  routeSourceIndexSearch,
  type SourceIndexCorpusSearchAdapter,
  type SourceIndexRoutedSearchHit,
  type SourceIndexRouterAdapterMap,
} from '../src/core/source-index/router.ts';
import {
  buildSourceSensitivity,
  type SourceItemIdentity,
  type SourceTrustTier,
} from '../src/core/source-index/types.ts';
import { createAnalyst, type AnalystModelRequest, type CreateAnalystOptions } from '../src/core/analyst.ts';
import { createStructuredEvidenceFact } from '../src/core/opsec.ts';
import { SourceModelPolicyDeniedError } from '../src/core/source-model-policy.ts';
import { OperationError } from '../src/core/operation-error.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const INTERNAL = 'internal.notes.docs';
const SECURE = 'secure_local.dropbox.files';
const SECURE_EMAIL = 'secure_local.email.private';
const PROTECTED_TELEGRAM = 'secure_local.telegram.protected.messages';
const WHATSAPP = 'secure_local.whatsapp.messages';
const OTHER = 'internal.other.docs';
const INTERNAL_SECRET = 'INTERNAL-RAW-CHUNK-TEXT cholesterol LDL 100 mg/dL';
const SECURE_SECRET = 'SECURE-RAW-CHUNK-TEXT total testosterone 612 ng/dL';
// Local-leg prompt budget for the fitting tests (measured with
// analystPromptBytes against the fixtures below): the whole two-candidate
// pack is ~3,290 bytes, so 3,200 forces a fit that keeps one candidate, the
// Personal note (first in round-robin order).
const ONE_CANDIDATE_PROMPT_BYTES = 3_200;

function adapterReturning(ids: string[]): SourceIndexCorpusSearchAdapter {
  return (request) => ({
    hits: ids.slice(0, request.maxResults).map((id, index) => ({
      sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: id, providerFileId: id, localItemId: id },
      provenance: {
        sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: id, providerFileId: id, localItemId: id },
        citation: { title: `${id}.pdf`, uri: `/files/${id}.pdf` },
      },
      score: 1 - index * 0.1,
      rawExposed: false as const,
    })),
    latencyMs: 1,
    laneAudits: [{
      laneName: `${ids[0]}-keyword`,
      laneType: 'keyword' as const,
      candidateCount: ids.length,
      returnedCount: ids.length,
      localOnly: true,
      rawExposed: false,
    }],
    rawExposed: false as const,
  });
}

interface ContentFetchCall {
  corpusId: string;
  maxChars: number | undefined;
}

function lanesFixture(
  input: { internal?: string[]; secure?: string[]; other?: string[] },
  options: { contentFetchCalls?: ContentFetchCall[] } = {},
) {
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId: INTERNAL, family: 'file', trustDomain: 'internal' }),
    defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
    defineSourceIndexCorpus({ corpusId: OTHER, family: 'file', trustDomain: 'internal' }),
  ]);
  const adapters: Record<string, SourceIndexCorpusSearchAdapter> = {};
  if (input.internal) adapters[INTERNAL] = adapterReturning(input.internal);
  if (input.secure) adapters[SECURE] = adapterReturning(input.secure);
  if (input.other) adapters[OTHER] = adapterReturning(input.other);
  const contentProviders = {
    [INTERNAL]: {
      async fetchLocalContent(request: LocalContentRequest) {
        options.contentFetchCalls?.push({ corpusId: INTERNAL, maxChars: request.maxChars });
        return {
          sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
          chunks: [INTERNAL_SECRET],
        };
      },
    },
    [SECURE]: {
      async fetchLocalContent(request: LocalContentRequest) {
        options.contentFetchCalls?.push({ corpusId: SECURE, maxChars: request.maxChars });
        return {
          sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
          chunks: [SECURE_SECRET],
        };
      },
    },
    [OTHER]: {
      async fetchLocalContent(request: LocalContentRequest) {
        options.contentFetchCalls?.push({ corpusId: OTHER, maxChars: request.maxChars });
        return {
          sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
          chunks: ['OTHER-RAW-CHUNK-TEXT unrelated'],
        };
      },
    },
  };
  return {
    registry,
    adapters: adapters as SourceIndexRouterAdapterMap,
    contentProviders: contentProviders as LocalContentProviderMap,
  };
}

interface ScriptedCall {
  pack: EvidencePack;
  options: AnalystOptions;
}

function scriptedAnalyst(
  respond: (pack: EvidencePack) => AnalystResult,
): { analyst: Analyst; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  return {
    calls,
    analyst: {
      async analyze(pack, options) {
        calls.push({ pack, options });
        return respond(pack);
      },
    },
  };
}

function citingFirstCandidate(answer: string, claim: string, unanswered: string[] = []) {
  return (pack: EvidencePack): AnalystResult => ({
    answer,
    citations: pack.candidates.length > 0
      ? [{ provenance: pack.candidates[0]!.provenance, claim }]
      : [],
    unanswered,
  });
}

interface WhatsAppMessageSpec {
  id: string;
  conversationId: string;
  text: string;
  sentAt: string;
  title?: string;
}

function createWhatsAppFixtureConnector(messages: readonly WhatsAppMessageSpec[]): SourceConnector {
  const rawItems = messages.map(whatsAppRawItem);
  return {
    id: 'whatsapp.fixture',
    family: 'chat',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: rawItems, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = rawItems.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!item) throw new Error(`missing WhatsApp fixture item ${localItemId}`);
      return item;
    },
    classificationSignals() {
      return {};
    },
  };
}

function whatsAppRawItem(message: WhatsAppMessageSpec): RawItem {
  const identity: SourceItemIdentity = {
    family: 'chat',
    provider: 'whatsapp',
    accountScope: 'personal',
    providerItemId: message.id,
    providerConversationId: message.conversationId,
    localItemId: `personal:${message.conversationId}:${message.id}`,
    sourceVersion: `${message.id}:v1`,
  };
  return {
    identity,
    mimeType: 'text/plain',
    content: { kind: 'text', text: message.text },
    metadata: Object.freeze({
      title: message.title ?? `WhatsApp ${message.conversationId}`,
      sentAt: message.sentAt,
      locatorUri: `whatsapp://${message.conversationId}/${message.id}`,
    }),
    fetchedAt: '2026-07-08T20:00:00.000Z',
  };
}

describe('analyst-backed source_answer handler', () => {
  test('releases an internal answer with citations, audits, and no raw chunk text', async () => {
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('Your most recent LDL was 100 mg/dL.', 'LDL 100 mg/dL'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
    });

    const result = await handler.answer({ question: 'What was my LDL?' });

    expect(result.answer).toContain('LDL was 100 mg/dL');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      corpus_id: INTERNAL,
      trust_domain: 'internal',
      provider_item_id: 'doc-1',
      title: 'doc-1.pdf',
    });
    expect(result.audit.searched_corpora).toContain(INTERNAL);
    expect(result.audit.lane_audits.length).toBeGreaterThan(0);
    expect(result.audit.phase_timings).toMatchObject({
      lane_setup_ms: expect.any(Number),
      bulk_gate_ms: expect.any(Number),
      evidence_pack_ms: expect.any(Number),
      analyst_ms: expect.any(Number),
      release_gate_ms: expect.any(Number),
      total_ms: result.audit.latency_ms,
    });
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.policy.internal_content_exposed).toBe(true);
    expect(result.policy.secure_local_content_exposed).toBe(false);
    expect(result.policy.castor_safe_bridge).toBe(true);
    expect(calls[0]!.options.localOnly).toBe(false);
    // Membrane: the raw chunk text never reaches the Castor-visible result.
    expect(JSON.stringify(result)).not.toContain('INTERNAL-RAW-CHUNK-TEXT');
  });

  test('generic source answers do not search secure_local by default', async () => {
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('Internal answer.', 'internal claim'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'], secure: ['lab-1'] }),
    });

    const result = await handler.answer({ question: 'What do my notes say?' });

    const skipped = result.audit.skipped_corpora.find((s) => s.corpus_id === SECURE);
    expect(skipped?.reason).toBe('trust_domain_not_allowed');
    expect(result.audit.answer_synthesis.secure_local_items_consulted).toBe(0);
    expect(calls[0]!.options.localOnly).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('uses a bounded default evidence budget for live source answers', async () => {
    const contentFetchCalls: ContentFetchCall[] = [];
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('Bounded answer.', 'bounded claim'),
    );
    const docs = Array.from({ length: 30 }, (_, index) => `doc-${index + 1}`);
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: docs }, { contentFetchCalls }),
    });

    const result = await handler.answer({ question: 'What do my docs say?' });

    // A broad match fills the default 24 candidates, which share the
    // 40,000-char passage budget.
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(calls[0]!.pack.candidates).toHaveLength(24);
    expect(contentFetchCalls).toHaveLength(24);
    expect(contentFetchCalls.every((call) => call.maxChars === 1_666)).toBe(true);

    // A caller asking for fewer gets fewer, each at the per-candidate ceiling.
    contentFetchCalls.length = 0;
    await handler.answer({ question: 'What do my docs say?', max_results: 2 });
    expect(calls[1]!.pack.candidates).toHaveLength(2);
    expect(contentFetchCalls.every((call) => call.maxChars === 3_000)).toBe(true);
  });

  test('defaults to one shared hybrid retrieval pass when mode is unspecified', async () => {
    const retrievalModes: string[] = [];
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('Semantic answer found the related project note.', 'semantic claim'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: (request) => {
        const mode = request.retrieval_mode ?? 'keyword';
        retrievalModes.push(mode);
        return lanesFixture({ internal: mode === 'hybrid' ? ['semantic-doc'] : [] });
      },
    });

    const result = await handler.answer({ question: 'What ideas are related to project phoenix?' });

    expect(retrievalModes).toEqual(['hybrid']);
    expect(calls[0]!.pack.candidates[0]!.provenance.sourceItem.providerItemId).toBe('semantic-doc');
    expect(result.evidence[0]).toMatchObject({
      corpus_id: INTERNAL,
      provider_item_id: 'semantic-doc',
    });
    expect(result.audit.lane_audits.some((lane) => lane.laneName === 'source_answer:adaptive_retrieval')).toBe(false);
  });

  test('semantic relevance gate drives an off-domain connector store through the honest zero-evidence path', async () => {
    const corpusId = 'internal.x.bookmarks';
    const account = 'personal';
    const item: RawItem = {
      identity: {
        family: 'x',
        provider: 'x',
        accountScope: account,
        providerItemId: 'post-1',
        localItemId: `${account}:post-1`,
        sourceVersion: 'v1',
      },
      mimeType: 'text/plain',
      content: { kind: 'text', text: 'A product strategy note about retrieval quality.' },
      metadata: Object.freeze({ title: 'Retrieval quality note' }),
      fetchedAt: '2026-07-25T06:00:00.000Z',
    };
    const connector: SourceConnector = {
      id: 'x.fixture',
      family: 'x',
      async authenticate() {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          yield { items: [item], done: true };
        })();
      },
      async fetchItem() {
        return item;
      },
      classificationSignals() {
        return {};
      },
    };
    const embeddingProvider: SourceEmbeddingProvider = {
      provider: 'fake-gemini',
      modelId: 'fake-x-relevance-v1',
      dimension: 2,
      configHash: 'fake-x-relevance',
      epochId: 'cloud:fake-x-relevance-v1:2',
      backend: 'cloud',
      async embed(inputs, options) {
        return inputs.map(() => options.taskType === 'RETRIEVAL_QUERY'
          ? [1, 0]
          : [0.3, Math.sqrt(0.91)]);
      },
    };
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId,
      family: 'x',
      trustDomain: 'internal',
    });
    try {
      await store.syncFromConnector(connector, { fetchContent: true });
      await store.embedChunks({ provider: embeddingProvider });
      const { analyst, calls } = scriptedAnalyst(() => ({
        answer: 'I could not find support for that.',
        citations: [],
        unanswered: [],
      }));
      const handler = createAnalystSourceIndexAnswerHandler({
        analyst,
        lanes: (request) => ({
          registry: buildSourceIndexCorpusRegistry([
            defineConnectorCorpus({ corpusId, family: 'x', trustDomain: 'internal' }),
          ]),
          adapters: {
            [corpusId]: createConnectorStoreCorpusAdapter({
              store,
              embeddingProvider,
              retrievalMode: request.retrieval_mode ?? 'keyword',
              semanticRelevanceBar: 0.45,
              accountScope: account,
            }),
          },
          contentProviders: {
            [corpusId]: createConnectorStoreContentProvider({ store }),
          },
        }),
      });

      const question = 'sourdough starter hydration schedule';
      const result = await handler.answer({ question, corpus_id: corpusId });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.pack.candidates).toEqual([]);
      expect(calls[0]!.pack.coverage.searchedCorpora).toEqual([corpusId]);
      expect(result.evidence).toEqual([]);
      expect(result.answer).toContain(
        `No supporting evidence was found in the searched corpora for this question: ${corpusId}.`,
      );
      expect(result.audit.lane_audits).toContainEqual(expect.objectContaining({
        laneType: 'semantic',
        candidateCount: 1,
        returnedCount: 0,
        bestCosine: 0.3,
        suppressedBelowBar: 1,
        skippedReason: 'semantic_below_relevance_bar',
      }));
      expect(JSON.stringify(result.audit)).not.toContain(question);
      expect(JSON.stringify(result.audit)).not.toContain('Retrieval quality note');
      expect(JSON.stringify(result.audit)).not.toContain('product strategy');
    } finally {
      store.close();
    }
  });

  test('explicit keyword retrieval remains authoritative', async () => {
    const retrievalModes: string[] = [];
    const { analyst } = scriptedAnalyst(() => ({
      answer: 'The evidence does not contain a matching source.',
      citations: [],
      unanswered: ['No source supports the requested answer.'],
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: (request) => {
        const mode = request.retrieval_mode ?? 'keyword';
        retrievalModes.push(mode);
        return lanesFixture({ internal: mode === 'hybrid' ? ['semantic-doc'] : [] });
      },
    });

    await handler.answer({
      question: 'What ideas are related to project phoenix?',
      retrieval_mode: 'keyword',
    });

    expect(retrievalModes).toEqual(['keyword']);
  });

  test('passes planned query variants into source_answer retrieval and RRF-fuses hits', async () => {
    const routedQueries: string[] = [];
    const question = 'What happened with the Lexidy credit?';
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('The planned retrieval found the evidence.', 'planned query evidence'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      queryPlanner: async () => ['Lexidy balance', 'Lexidy amount on account', 'ignored fourth query'],
      lanes: () => {
        const lanes = lanesFixture({ internal: [] });
        const plannedAdapter: SourceIndexCorpusSearchAdapter = (request) => {
          routedQueries.push(request.query);
          const idsByQuery: Record<string, string[]> = {
            [question]: ['literal-doc'],
            'Lexidy balance': ['credit-doc'],
            'Lexidy amount on account': ['literal-doc'],
          };
          return adapterReturning(idsByQuery[request.query] ?? [])(request);
        };
        return {
          ...lanes,
          adapters: { ...lanes.adapters, [INTERNAL]: plannedAdapter },
        };
      },
    });

    await handler.answer({ question });

    expect(routedQueries).toEqual([question, 'Lexidy balance', 'Lexidy amount on account']);
    expect(calls[0]!.pack.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId)).toEqual([
      'literal-doc',
      'credit-doc',
    ]);
  });

  test('a strong literal run answers without waiting for the planner (P6-L4)', async () => {
    const routedQueries: string[] = [];
    const question = 'What happened with the Lexidy credit?';
    let plannerStarted = 0;
    let plannerSettled = false;
    let releasePlanner: () => void = () => {};
    const plannerGate = new Promise<void>((resolve) => {
      releasePlanner = resolve;
    });
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('The literal retrieval was enough.', 'literal evidence'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      // maxResults 2, and the literal query returns 2 hits: a full cut.
      defaultMaxResults: 2,
      queryPlanner: async () => {
        plannerStarted += 1;
        await plannerGate;
        plannerSettled = true;
        return ['Lexidy balance'];
      },
      lanes: () => {
        const lanes = lanesFixture({ internal: [] });
        const plannedAdapter: SourceIndexCorpusSearchAdapter = (request) => {
          routedQueries.push(request.query);
          const idsByQuery: Record<string, string[]> = {
            [question]: ['literal-a', 'literal-b'],
            'Lexidy balance': ['credit-doc'],
          };
          return adapterReturning(idsByQuery[request.query] ?? [])(request);
        };
        return { ...lanes, adapters: { ...lanes.adapters, [INTERNAL]: plannedAdapter } };
      },
    });

    const result = await handler.answer({ question });

    // The planner raced (it was started) but the answer never waited for it.
    expect(plannerStarted).toBe(1);
    expect(plannerSettled).toBe(false);
    expect(routedQueries).toEqual([question]);
    expect(calls[0]!.pack.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId)).toEqual([
      'literal-a',
      'literal-b',
    ]);
    expect(result.answer).toContain('The literal retrieval was enough.');

    releasePlanner();
  });

  test('an explicitly pinned retrieval_mode keeps planner expansions on its own lane', async () => {
    const retrievalModes: string[] = [];
    const routedQueries: string[] = [];
    const question = 'What ideas are related to project phoenix?';
    const { analyst } = scriptedAnalyst(
      citingFirstCandidate('Pinned keyword answer.', 'pinned evidence'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      queryPlanner: async () => ['phoenix themes'],
      lanes: (request) => {
        const mode = request.retrieval_mode ?? 'keyword';
        retrievalModes.push(mode);
        const lanes = lanesFixture({ internal: [] });
        const plannedAdapter: SourceIndexCorpusSearchAdapter = (adapterRequest) => {
          routedQueries.push(adapterRequest.query);
          const idsByQuery: Record<string, string[]> = {
            [question]: ['literal-doc'],
            'phoenix themes': ['theme-doc'],
          };
          return adapterReturning(idsByQuery[adapterRequest.query] ?? [])(adapterRequest);
        };
        return { ...lanes, adapters: { ...lanes.adapters, [INTERNAL]: plannedAdapter } };
      },
    });

    await handler.answer({ question, retrieval_mode: 'keyword' });

    // Pinned mode is untouched: still one lane construction and the thin
    // literal run still gets its expansion.
    expect(retrievalModes).toEqual(['keyword']);
    expect(routedQueries).toEqual([question, 'phoenix themes']);
  });

  test('allows explicit evidence budget overrides for diagnostic source answers', async () => {
    const contentFetchCalls: ContentFetchCall[] = [];
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('Wider answer.', 'wider claim'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      defaultMaxResults: 2,
      maxCharsPerCandidate: 750,
      lanes: () =>
        lanesFixture(
          { internal: ['doc-1', 'doc-2', 'doc-3'] },
          { contentFetchCalls },
        ),
    });

    await handler.answer({ question: 'What do my docs say?' });

    expect(calls[0]!.pack.candidates).toHaveLength(2);
    expect(contentFetchCalls).toHaveLength(2);
    expect(contentFetchCalls.every((call) => call.maxChars === 750)).toBe(true);
  });

  test('corpus_ids bounds compound source answers without all-corpus fanout', async () => {
    const contentFetchCalls: ContentFetchCall[] = [];
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('Compound answer.', 'compound'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () =>
        lanesFixture(
          { internal: ['doc-1'], secure: ['lab-1'], other: ['other-1'] },
          { contentFetchCalls },
        ),
    });

    const result = await handler.answer({
      question: 'Answer from the lab and Telegram corpora.',
      corpus_ids: [SECURE, INTERNAL],
    });

    expect(result.audit.searched_corpora.sort()).toEqual([INTERNAL, SECURE].sort());
    expect(calls[0]!.pack.candidates).toHaveLength(2);
    expect(contentFetchCalls.map((call) => call.corpusId).sort()).toEqual([INTERNAL, SECURE].sort());
    expect(contentFetchCalls.some((call) => call.corpusId === OTHER)).toBe(false);
  });

  test('no-corpus fan-out is driven by the registry, including newly registered answer corpora', async () => {
    const registered = 'internal.registry-added.notes';
    const { analyst, calls } = scriptedAnalyst((pack) => {
      expect(pack.coverage.searchedCorpora).toEqual([registered]);
      expect(pack.candidates).toHaveLength(1);
      return {
        answer: 'The registry-added corpus participated in the answer.',
        citations: [{
          provenance: pack.candidates[0]!.provenance,
          claim: 'registered corpus evidence',
        }],
        unanswered: [],
      };
    });
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => ({
        registry: buildSourceIndexCorpusRegistry([
          defineSourceIndexCorpus({ corpusId: registered, family: 'file', trustDomain: 'internal' }),
        ]),
        adapters: {
          [registered]: adapterReturning(['registry-doc']),
        },
        contentProviders: {
          [registered]: {
            async fetchLocalContent() {
              return {
                sensitivity: buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }),
                chunks: ['registered corpus evidence'],
              };
            },
          },
        },
      }),
    });

    const result = await handler.answer({ question: 'What does the registry-added corpus say?' });

    expect(calls[0]!.options.localOnly).toBe(false);
    expect(result.audit.searched_corpora).toEqual([registered]);
    expect(result.evidence).toEqual([expect.objectContaining({
      corpus_id: registered,
      provider_item_id: 'registry-doc',
    })]);
    expect(result.answer).not.toContain('Coverage notes:');
  });

  test('empty released evidence gains a corpus-derived coverage note when the analyst omits unanswered items', async () => {
    const { analyst, calls } = scriptedAnalyst(() => ({
      answer: 'I could not find support for that.',
      citations: [],
      unanswered: [],
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: [] }),
    });

    const result = await handler.answer({
      question: 'What do the selected notes establish?',
      corpus_id: INTERNAL,
    });

    expect(calls[0]!.pack.coverage.searchedCorpora).toEqual([INTERNAL]);
    expect(calls[0]!.pack.coverage.extractionGaps).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.answer).toContain('Coverage notes:');
    expect(result.answer).toContain(
      `No supporting evidence was found in the searched corpora for this question: ${INTERNAL}.`,
    );
    expect(result.answer).not.toContain('What do the selected notes establish?');
  });

  test('include_secure_local with no corpus fan-out searches all private answer corpora', async () => {
    const searched: string[] = [];
    const { analyst, calls } = scriptedAnalyst((pack) => {
      expect([...pack.coverage.searchedCorpora].sort()).toEqual([
        PROTECTED_TELEGRAM,
        SECURE,
        SECURE_EMAIL,
      ].sort());
      expect(pack.candidates).toHaveLength(3);
      expect(pack.candidates.every((candidate) => candidate.trustDomain === 'secure_local')).toBe(true);
      return {
        answer: 'I found private email, Dropbox, and protected Telegram evidence for the question.',
        citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'private evidence was found' }],
        unanswered: [],
      };
    });
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const registry = buildSourceIndexCorpusRegistry([
          defineSourceIndexCorpus({ corpusId: SECURE_EMAIL, family: 'email', trustDomain: 'secure_local' }),
          defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
          defineSourceIndexCorpus({ corpusId: PROTECTED_TELEGRAM, family: 'chat', trustDomain: 'secure_local' }),
        ]);
        const adapterFor = (corpusId: string, family: 'email' | 'file' | 'chat'): SourceIndexCorpusSearchAdapter => (request) => {
          searched.push(corpusId);
          const provider = family === 'email' ? 'gmail' : family === 'chat' ? 'telegram' : 'dropbox';
          return {
            hits: [{
              sourceItem: {
                family,
                provider,
                accountScope: 'personal',
                providerItemId: `${corpusId}:item`,
                localItemId: `${corpusId}:item`,
              },
              provenance: {
                sourceItem: {
                  family,
                  provider,
                  accountScope: 'personal',
                  providerItemId: `${corpusId}:item`,
                  localItemId: `${corpusId}:item`,
                },
                citation: { title: `${corpusId} fixture` },
              },
              score: request.maxResults,
              rawExposed: false,
            }],
            latencyMs: 1,
            rawExposed: false,
          };
        };
        const contentProviders = Object.fromEntries([SECURE_EMAIL, SECURE, PROTECTED_TELEGRAM].map((corpusId) => [
          corpusId,
          {
            async fetchLocalContent() {
              return {
                sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                chunks: [`bounded private content from ${corpusId}`],
              };
            },
          },
        ]));
        return {
          registry,
          adapters: {
            [SECURE_EMAIL]: adapterFor(SECURE_EMAIL, 'email'),
            [SECURE]: adapterFor(SECURE, 'file'),
            [PROTECTED_TELEGRAM]: adapterFor(PROTECTED_TELEGRAM, 'chat'),
          },
          contentProviders: contentProviders as LocalContentProviderMap,
        };
      },
    });

    const result = await handler.answer({
      question: 'What does my private material say about Lexidy credit?',
      include_secure_local: true,
    });

    expect(searched.sort()).toEqual([PROTECTED_TELEGRAM, SECURE, SECURE_EMAIL].sort());
    expect(calls[0]!.options.localOnly).toBe(true);
    expect(result.audit.answer_synthesis.secure_local_items_consulted).toBe(3);
    expect(result.audit.skipped_corpora).toEqual([]);
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(JSON.stringify(result)).not.toContain('bounded private content');
  });

  test('unified secure ask retrieves WhatsApp connector-store evidence through a planner variant', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: WHATSAPP,
      family: 'chat',
      trustDomain: 'secure_local',
    });
    try {
      await store.syncFromConnector(createWhatsAppFixtureConnector([{
        id: 'wa-1',
        conversationId: 'family-health',
        text: 'We discussed the new cholesterol panel: HDL improved and ApoB stayed stable.',
        sentAt: '2026-07-08T19:15:00.000Z',
        title: 'Family health chat',
      }]), { fetchContent: true });

      const routedQueries: string[] = [];
      const { analyst, calls } = scriptedAnalyst((pack) => {
        expect(pack.coverage.searchedCorpora).toEqual([WHATSAPP]);
        expect(pack.candidates).toHaveLength(1);
        expect(pack.candidates[0]!.chunks.join('\n')).toContain('HDL improved');
        return {
          answer: 'The WhatsApp discussion said HDL improved and ApoB stayed stable.',
          citations: [{
            provenance: pack.candidates[0]!.provenance,
            claim: 'HDL improved and ApoB stayed stable.',
          }],
          unanswered: [],
        };
      });
      const adapter = createConnectorStoreCorpusAdapter({ store });
      const handler = createAnalystSourceIndexAnswerHandler({
        analyst,
        queryPlanner: async () => ['cholesterol HDL ApoB'],
        lanes: () => ({
          registry: buildSourceIndexCorpusRegistry([
            defineConnectorCorpus({ corpusId: WHATSAPP, family: 'chat', trustDomain: 'secure_local' }),
          ]),
          adapters: {
            [WHATSAPP]: async (request) => {
              routedQueries.push(request.query);
              return adapter(request);
            },
          },
          contentProviders: {
            [WHATSAPP]: createConnectorStoreContentProvider({ store }),
          },
        }),
      });

      const result = await handler.answer({
        question: 'What did we say about the recent health numbers?',
        include_secure_local: true,
        retrieval_mode: 'keyword',
      });

      expect(routedQueries).toEqual([
        'What did we say about the recent health numbers?',
        'cholesterol HDL ApoB',
      ]);
      expect(calls[0]!.options.localOnly).toBe(true);
      expect(result.evidence).toEqual([expect.objectContaining({
        corpus_id: WHATSAPP,
        trust_domain: 'secure_local',
        provider: 'whatsapp',
        provider_item_id: 'wa-1',
        uri: 'whatsapp://family-health/wa-1',
      })]);
      expect(result.audit.answer_synthesis.secure_local_items_consulted).toBe(1);
      expect(result.opsec.release_decision.decision).toBe('allow');
      expect(JSON.stringify(result)).not.toContain('We discussed the new cholesterol panel');
    } finally {
      store.close();
    }
  });

  test('registry-listed secure WhatsApp corpus is not searched without the secure-local flag', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: WHATSAPP,
      family: 'chat',
      trustDomain: 'secure_local',
    });
    try {
      await store.syncFromConnector(createWhatsAppFixtureConnector([{
        id: 'wa-1',
        conversationId: 'family-health',
        text: 'cholesterol HDL ApoB',
        sentAt: '2026-07-08T19:15:00.000Z',
      }]), { fetchContent: true });

      const { analyst, calls } = scriptedAnalyst((pack) => {
        expect(pack.candidates).toEqual([]);
        return {
          answer: 'No allowed evidence matched.',
          citations: [],
          unanswered: ['secure-local WhatsApp was not allowed for this request.'],
        };
      });
      const handler = createAnalystSourceIndexAnswerHandler({
        analyst,
        lanes: () => ({
          registry: buildSourceIndexCorpusRegistry([
            defineConnectorCorpus({ corpusId: WHATSAPP, family: 'chat', trustDomain: 'secure_local' }),
          ]),
          adapters: {
            [WHATSAPP]: createConnectorStoreCorpusAdapter({ store }),
          },
          contentProviders: {
            [WHATSAPP]: createConnectorStoreContentProvider({ store }),
          },
        }),
      });

      const result = await handler.answer({ question: 'cholesterol HDL ApoB' });

      expect(calls).toHaveLength(1);
      expect(result.audit.searched_corpora).toEqual([]);
      expect(result.audit.skipped_corpora).toContainEqual({
        corpus_id: WHATSAPP,
        trust_domain: 'secure_local',
        reason: 'trust_domain_not_allowed',
      });
      expect(result.audit.answer_synthesis.secure_local_items_consulted).toBe(0);
    } finally {
      store.close();
    }
  });

  test('secure_local answers release as bounded derivatives by default (frontier-max)', async () => {
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('Total testosterone was 612 ng/dL on 2025-04-22.', '612 ng/dL on 2025-04-22'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    // No release flag needed: the value flows as a bounded derivative with a
    // full audit; raw chunk text never crosses.
    const released = await handler.answer({ question: 'Latest testosterone?', include_secure_local: true });
    expect(released.answer).toContain('612 ng/dL');
    expect(released.opsec.release_decision.decision).toBe('allow');
    expect(released.opsec.release_decision.reasons).toContain('bounded_secure_derivative_allowed');
    expect(released.policy.secure_local_content_exposed).toBe(true);
    expect(calls[0]!.options.localOnly).toBe(true);
    expect(JSON.stringify(released)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('ambiguous cloned citations across corpora fail closed instead of inheriting the wrong trust domain', async () => {
    const { analyst } = scriptedAnalyst((pack) => {
      expect(pack.candidates).toHaveLength(2);
      const secureCandidate = pack.candidates.find((candidate) => candidate.trustDomain === 'secure_local');
      expect(secureCandidate).toBeDefined();
      return {
        answer: 'The shared lab value was 612 ng/dL.',
        citations: [{
          provenance: {
            ...secureCandidate!.provenance,
            sourceItem: { ...secureCandidate!.provenance.sourceItem },
          },
          claim: '612 ng/dL',
        }],
        unanswered: [],
      };
    });
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['shared-lab'], secure: ['shared-lab'] }),
    });

    const result = await handler.answer({
      question: 'What is the shared lab value?',
      corpus_ids: [INTERNAL, SECURE],
      include_secure_local: true,
    });

    expect(result.opsec.release_decision.decision).toBe('needs_approval');
    expect(result.opsec.release_decision.required_approval).toBe('s4_release');
    expect(result.opsec.structured_evidence).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.answer).not.toContain('612 ng/dL');
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('bounded secure-local answer is not blocked by raw-text safety instructions', async () => {
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('LDL was 92 mg/dL and ApoB was 74 mg/dL.', 'LDL was 92 mg/dL and ApoB was 74 mg/dL'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const released = await handler.answer({
      question: [
        'What do my latest secure-local lab sources say about LDL/ApoB?',
        'Do not use bash, shell, sqlite3, browser, local file, raw DB, or any other fallback tool.',
        'Cite source-answer evidence, state coverage gaps honestly, and do not expose raw secure-local source text.',
      ].join(' '),
      corpus_id: SECURE,
    });

    expect(calls).toHaveLength(1);
    expect(released.answer).toContain('LDL was 92 mg/dL');
    expect(released.opsec.release_decision.decision).toBe('allow');
    expect(released.opsec.release_decision.reasons).toContain('bounded_secure_derivative_allowed');
    expect(released.policy.secure_local_content_exposed).toBe(true);
    expect(JSON.stringify(released)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('bulk secure-local export requests require approval before analyst release', async () => {
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('This should not be released.', 'sensitive secure claim'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: 'Export all of my secure local lab records with the full text.',
    });

    expect(calls).toHaveLength(0);
    expect(result.opsec.release_decision.decision).toBe('needs_approval');
    expect(result.opsec.release_decision.required_approval).toBe('s4_release');
    expect(result.opsec.release_decision.reasons).toContain('bulk_secure_local_release_requires_approval');
    expect(result.policy.secure_local_content_exposed).toBe(false);
    expect(result.evidence).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('explicit Venice S4 requests do not bypass the pre-analyst bulk approval gate', async () => {
    const local = scriptedAnalyst(
      citingFirstCandidate('Local fallback should not be needed.', 'local fallback claim'),
    );
    const venice = scriptedAnalyst(
      citingFirstCandidate('Venice must not see the raw secure pack.', 'Venice bounded S4 claim'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      veniceAnalyst: () => venice.analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: 'Use Venice GLM 5.2 E2EE to analyze all secure local lab records. Do not expose raw source text to Castor.',
      corpus_id: SECURE,
      analyst_provider: 'venice',
      analyst_model: 'e2ee-glm-5-2-p',
    });

    expect(venice.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(0);
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
    expect(result.audit.answer_synthesis.requested_analyst_provider).toBe('venice');
    expect(result.opsec.release_decision.decision).toBe('needs_approval');
    expect(result.opsec.release_decision.reasons).toContain('bulk_secure_local_release_requires_approval');
    expect(result.answer).not.toContain('Venice must not see the raw secure pack');
  });

  test('bounded single-file lab analysis is not treated as bulk secure-local export', async () => {
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('All available values in the selected file were reviewed; LDL was 92 mg/dL.', 'LDL was 92 mg/dL.'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: [
        "Analyze this specific latest lab file, '2026-05-21 metabolic panel and tests.pdf'.",
        'Extract all available blood work values and flags from this file, especially abnormal/notable markers,',
        'then give a clinically cautious analysis and follow-up questions.',
      ].join(' '),
      corpus_id: SECURE,
    });

    expect(calls).toHaveLength(1);
    expect(result.answer).toContain('LDL was 92 mg/dL');
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.opsec.release_decision.reasons).toContain('bounded_secure_derivative_allowed');
  });

  test('bounded cross-file abnormal-only lab analysis is not blocked by negated dump wording', async () => {
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('Recent abnormal-only trend summary: ApoB was notable.', 'ApoB was notable.'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1', 'lab-2'] }),
    });

    const result = await handler.answer({
      question: [
        "Across the owner's recent lab files, return only abnormal, out-of-range, or clinically notable blood-work findings and trends.",
        'Do not dump full panels.',
        'Include dates, concise interpretation, and physician follow-up questions.',
      ].join(' '),
      query: 'abnormal out of range high low blood work glucose A1c insulin cholesterol LDL HDL triglycerides',
      corpus_id: SECURE,
      max_results: 2,
    });

    expect(calls).toHaveLength(1);
    expect(result.answer).toContain('ApoB was notable');
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.opsec.release_decision.reasons).toContain('bounded_secure_derivative_allowed');
  });

  test('natural Castor lab plus Telegram synthesis is not treated as a bulk secure-local export', async () => {
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('LDL/ApoB and biomarker synthesis stayed bounded and cited.', 'LDL/ApoB bounded synthesis.'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'], internal: ['telegram-1'] }),
    });

    const result = await handler.answer({
      question: 'What do all of my latest secure-local lab sources say about LDL/ApoB, and what does the Happy Fourth Crypto Bear Telegram source say about biomarkers?',
      query: 'LDL ApoB biomarkers Happy Fourth Crypto Bear lab Telegram',
      corpus_ids: [SECURE, INTERNAL],
      max_results: 2,
    });

    expect(calls).toHaveLength(1);
    expect(result.answer).toContain('LDL/ApoB and biomarker synthesis');
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.opsec.release_decision.reasons).not.toContain('bulk_secure_local_release_requires_approval');
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('bulk secure-local approval is intent-scoped even when retrieval would find no candidates', async () => {
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('This should not run.', 'secure claim'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: [] }),
    });

    const result = await handler.answer({
      question: 'Dump all secure-local lab source text.',
      corpus_id: SECURE,
    });

    expect(calls).toHaveLength(0);
    expect(result.audit.searched_corpora).toEqual([SECURE]);
    expect(result.audit.lane_audits).toEqual([]);
    expect(result.audit.phase_timings).toMatchObject({
      lane_setup_ms: expect.any(Number),
      bulk_gate_ms: expect.any(Number),
      total_ms: result.audit.latency_ms,
    });
    expect(result.audit.phase_timings?.evidence_pack_ms).toBeUndefined();
    expect(result.audit.phase_timings?.analyst_ms).toBeUndefined();
    expect(result.audit.phase_timings?.release_gate_ms).toBeUndefined();
    expect(result.audit.answer_synthesis.secure_local_items_consulted).toBe(0);
    expect(result.opsec.release_decision.decision).toBe('needs_approval');
    expect(result.opsec.release_decision.required_approval).toBe('s4_release');
    expect(result.opsec.release_decision.reasons).toContain('bulk_secure_local_release_requires_approval');
    expect(result.policy.secure_local_content_exposed).toBe(false);
  });

  test('explicit Venice over secure-local packs dispatches Venice (owner-approved private cloud)', async () => {
    // OWNER DECISION (2026-07-02): venice is the owner's approved encrypted
    // private cloud for secure_local; an explicit venice request dispatches.
    const local = scriptedAnalyst(
      citingFirstCandidate('Local Argus says testosterone was 612 ng/dL.', 'Testosterone was 612 ng/dL.'),
    );
    const venice = scriptedAnalyst(
      citingFirstCandidate('Venice says testosterone was 612 ng/dL.', 'Testosterone was 612 ng/dL.'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      veniceAnalyst: () => venice.analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: 'Analyze my recent labs.',
      analyst_provider: 'venice',
      include_secure_local: true,
    });

    expect(venice.calls).toHaveLength(1);
    expect(local.calls).toHaveLength(0);
    expect(result.audit.answer_synthesis.analyst_backend).toBe('venice');
    expect(result.audit.answer_synthesis.analyst_fallback).toBeUndefined();
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.answer).toContain('612 ng/dL');
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('a caller cancellation during an explicit Venice or cloud leg ends the answer without a fallback leg', async () => {
    for (const provider of ['venice', 'cloud'] as const) {
      const local = scriptedAnalyst(citingFirstCandidate('Local must not run.', 'local claim'));
      const cancelling: Analyst = {
        async analyze() {
          const error = new Error('The caller cancelled this answer.');
          error.name = 'AbortError';
          throw error;
        },
      };
      const handler = createAnalystSourceIndexAnswerHandler({
        analyst: local.analyst,
        ...(provider === 'venice' ? { veniceAnalyst: () => cancelling } : { cloudAnalyst: cancelling }),
        lanes: () => lanesFixture({ internal: ['doc-1'] }),
      });

      const error = await handler.answer({ question: 'What did the notes say?', analyst_provider: provider })
        .catch((caught: unknown) => caught);

      expect((error as Error).name).toBe('AbortError');
      expect(local.calls).toHaveLength(0);
    }
  });

  test('explicit standard-cloud constraint over secure-local evidence refuses before route resolution', async () => {
    const local = scriptedAnalyst(
      citingFirstCandidate('Local must not run.', 'local claim'),
    );
    const cloud = scriptedAnalyst(
      citingFirstCandidate('Cloud must not run.', 'cloud claim'),
    );
    let sovereigntyRouteCalls = 0;
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      cloudAnalyst: cloud.analyst,
      sovereigntyAnalystRoute: () => {
        sovereigntyRouteCalls += 1;
        return [];
      },
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    await expect(handler.answer({
      question: 'Analyze my recent labs.',
      analyst_provider: 'cloud',
      include_secure_local: true,
    })).rejects.toMatchObject({
      code: 'source_index_policy_violation',
      message: 'The explicitly requested standard-cloud analyst is not eligible for secure-local evidence.',
    });

    expect(local.calls).toHaveLength(0);
    expect(cloud.calls).toHaveLength(0);
    expect(sovereigntyRouteCalls).toBe(0);
  });

  test('typed Venice category refusals never fall back to the local analyst', async () => {
    const local = scriptedAnalyst(
      citingFirstCandidate('Local fallback must not run.', 'local fallback claim'),
    );
    let veniceCalls = 0;
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      veniceAnalyst: () => ({
        async analyze() {
          veniceCalls += 1;
          throw new OperationError(
            'source_index_policy_violation',
            'Venice model category is below the secure-local floor.',
          );
        },
      }),
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    await expect(handler.answer({
      question: 'Analyze my recent labs.',
      analyst_provider: 'venice',
      include_secure_local: true,
    })).rejects.toMatchObject({ code: 'source_index_policy_violation' });

    expect(veniceCalls).toBe(1);
    expect(local.calls).toHaveLength(0);
  });

  test('secure-local default stays on local Argus even when Venice escalation is available', async () => {
    const local = scriptedAnalyst(
      citingFirstCandidate('Local Argus says LDL was 92 mg/dL.', 'LDL was 92 mg/dL.'),
    );
    let veniceCalls = 0;
    const neverReturningVenice: Analyst = {
      analyze() {
        veniceCalls += 1;
        return new Promise<AnalystResult>(() => undefined);
      },
    };
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      veniceAnalyst: () => neverReturningVenice,
      trustedAnalystTimeoutMs: 1,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({ question: 'Latest LDL?' });

    expect(veniceCalls).toBe(0);
    expect(local.calls).toHaveLength(1);
    expect(result.answer).toContain('LDL was 92 mg/dL');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
    expect(result.audit.answer_synthesis.analyst_fallback).toBeUndefined();
    expect(result.opsec.release_decision.decision).toBe('allow');
  });

  test('explicit Venice over secure-local packs is timeout-bounded with local fallback', async () => {
    // Venice attempts over secure packs are bounded by the trusted-analyst
    // timeout so a hung encrypted-cloud lane falls back to local Argus (the
    // live private-host posture: venice-first, local on timeout).
    const local = scriptedAnalyst(
      citingFirstCandidate('Local Argus says ApoB was 74 mg/dL.', 'ApoB was 74 mg/dL.'),
    );
    let veniceCalls = 0;
    const neverReturningVenice: Analyst = {
      analyze() {
        veniceCalls += 1;
        return new Promise<AnalystResult>(() => undefined);
      },
    };
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      veniceAnalyst: () => neverReturningVenice,
      trustedAnalystTimeoutMs: 1,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: 'Use Venice to analyze my recent blood work.',
      analyst_provider: 'venice',
      analyst_model: 'zai-org-glm-5-2',
      include_secure_local: true,
    });

    expect(veniceCalls).toBe(1);
    expect(local.calls).toHaveLength(1);
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
    expect(result.audit.answer_synthesis.analyst_fallback).toMatchObject({
      from: 'venice',
      to: 'local',
      reason: 'timeout',
    });
    expect(result.opsec.release_decision.decision).toBe('allow');
  });

  test('the tool watchdog budget (timeout_ms) no longer inflates the trusted analyst bound', async () => {
    // Answer-latency WO decoupling: request.timeout_ms is the OpenClaw tool
    // watchdog budget (the skill passes ~600s). It must NOT become the Venice
    // bound, or a ~20ms encrypted-cloud attempt silently becomes a 10-minute
    // one. With a tiny trusted bound and a huge watchdog budget, a hung Venice
    // still times out at the trusted bound and local Argus answers.
    const local = scriptedAnalyst(
      citingFirstCandidate('Local Argus says ApoB was 74 mg/dL.', 'ApoB was 74 mg/dL.'),
    );
    let veniceCalls = 0;
    const neverReturningVenice: Analyst = {
      analyze() {
        veniceCalls += 1;
        return new Promise<AnalystResult>(() => undefined);
      },
    };
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      veniceAnalyst: () => neverReturningVenice,
      trustedAnalystTimeoutMs: 20,
      lanes: () => lanesFixture({ internal: ['project-note-1'] }),
    });

    const result = await handler.answer({
      question: 'Use Venice to analyze my internal project notes.',
      analyst_provider: 'venice',
      timeout_ms: 600_000,
    });

    expect(veniceCalls).toBe(1);
    expect(local.calls).toHaveLength(1);
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
    // The bound is the trusted default (20ms), NOT the 600000ms watchdog budget.
    expect(result.audit.answer_synthesis.analyst_fallback).toMatchObject({
      from: 'venice',
      to: 'local',
      reason: 'timeout',
      timeout_ms: 20,
    });
    expect(result.answer).toContain('ApoB was 74 mg/dL');
  });

  test('a hung LOCAL analyst is bounded by its own budget and fails honestly', async () => {
    // The local lane gets its own generous ceiling, decoupled from both the
    // watchdog budget and the trusted bound. A wedged local model surfaces an
    // honest timeout instead of silently riding the watchdog to full length.
    const neverReturningLocal: Analyst = {
      analyze() {
        return new Promise<AnalystResult>(() => undefined);
      },
    };
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: neverReturningLocal,
      localAnalystTimeoutMs: 25,
      lanes: () => lanesFixture({ internal: ['project-note-1'] }),
    });

    await expect(
      handler.answer({ question: 'What do my project notes say?', analyst_provider: 'local' }),
    ).rejects.toThrow(/timed out/);
  });

  test('a slow-but-under-budget LOCAL analyst still answers (slow useful work is allowed)', async () => {
    const slowLocal: Analyst = {
      async analyze(pack) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return citingFirstCandidate('Local answer after some thinking.', 'thoughtful claim')(pack);
      },
    };
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: slowLocal,
      localAnalystTimeoutMs: 5_000,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
    });

    const result = await handler.answer({ question: 'What do my notes say?' });

    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.answer).toContain('Local answer after some thinking');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
  });

  test('uncited secure_local answers require review instead of releasing text without facts', async () => {
    const { analyst } = scriptedAnalyst(() => ({
      answer: 'Total testosterone was 612 ng/dL on 2025-04-22.',
      citations: [],
      unanswered: [],
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({ question: 'Latest testosterone?', include_secure_local: true });

    expect(result.opsec.release_decision.decision).toBe('needs_approval');
    expect(result.opsec.release_decision.required_approval).toBe('s4_release');
    expect(result.opsec.release_decision.reasons).toContain('uncited_non_public_answer');
    expect(result.policy.secure_local_content_exposed).toBe(false);
    expect(result.answer).not.toContain('612 ng/dL');
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('uncited secure_local no-support answers release without source content', async () => {
    const { analyst } = scriptedAnalyst(() => ({
      answer: 'The evidence does not contain or support a vaccination schedule.',
      citations: [],
      unanswered: ['No source supports the requested schedule.'],
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({ question: 'What is the vaccination schedule?', include_secure_local: true });

    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.opsec.release_decision.reasons).toContain('unsupported_answer_released_without_source_content');
    expect(result.answer).toContain('could not extract a cited bounded answer');
    expect(result.answer).not.toContain('vaccination schedule');
    expect(result.evidence).toEqual([]);
    expect(result.policy.secure_local_content_exposed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('uncited secure_local no-support answers do not release private analyst text', async () => {
    const privateDetail = 'Total testosterone was 612 ng/dL';
    const { analyst } = scriptedAnalyst(() => ({
      answer: `I could not answer from the source evidence. Private detail: ${privateDetail}.`,
      citations: [],
      unanswered: ['No source supports the requested answer.'],
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({ question: 'What is the vaccination schedule?', include_secure_local: true });

    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.opsec.release_decision.reasons).toContain('unsupported_answer_released_without_source_content');
    expect(result.answer).toContain('could not extract a cited bounded answer');
    expect(result.answer).not.toContain(privateDetail);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('uncited secure_local no-support answers still pass the secret release gate', async () => {
    const leakedSecret = 'api_key = sk_live_abcdef1234567890abcdef';
    const { analyst } = scriptedAnalyst(() => ({
      answer: `I could not answer from the source evidence. ${leakedSecret}`,
      citations: [],
      unanswered: ['No source supports the requested answer.'],
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({ question: 'What is the vaccination schedule?', include_secure_local: true });

    expect(result.opsec.release_decision.decision).toBe('deny');
    expect(result.opsec.release_decision.required_approval).toBe('s5_secret_use');
    expect(result.opsec.release_decision.reasons).toContain('unsupported_answer_released_without_source_content');
    expect(result.opsec.release_decision.reasons).toContain('s5_secret_denied_from_ordinary_output');
    expect(result.answer).not.toContain(leakedSecret);
    expect(JSON.stringify(result)).not.toContain(leakedSecret);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('uncited secure_local coverage notes pass the secret release gate', async () => {
    const leakedSecret = 'api_key = sk_live_abcdef1234567890abcdef';
    const { analyst } = scriptedAnalyst(() => ({
      answer: 'I could not answer from the source evidence.',
      citations: [],
      unanswered: [`No source supports the requested answer. ${leakedSecret}`],
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({ question: 'What is the vaccination schedule?', include_secure_local: true });

    expect(result.opsec.release_decision.decision).toBe('deny');
    expect(result.opsec.release_decision.required_approval).toBe('s5_secret_use');
    expect(result.opsec.release_decision.reasons).toContain('unsupported_answer_released_without_source_content');
    expect(result.opsec.release_decision.reasons).toContain('s5_secret_denied_from_ordinary_output');
    expect(result.answer).not.toContain(leakedSecret);
    expect(JSON.stringify(result)).not.toContain(leakedSecret);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('empty uncited secure_local answers do not release private coverage text', async () => {
    const privateDetail = 'Total testosterone was 612 ng/dL';
    const { analyst } = scriptedAnalyst(() => ({
      answer: '',
      citations: [],
      unanswered: [`No source supports this. Private detail: ${privateDetail}.`],
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({ question: 'What is the vaccination schedule?', include_secure_local: true });

    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.opsec.release_decision.reasons).toContain('unsupported_answer_released_without_source_content');
    expect(result.answer).toContain('could not extract a cited bounded answer');
    expect(result.answer).not.toContain(privateDetail);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('empty uncited secure_local non-unsupported coverage text requires approval', async () => {
    const privateDetail = 'Total testosterone was 612 ng/dL';
    const { analyst } = scriptedAnalyst(() => ({
      answer: '',
      citations: [],
      unanswered: [`Private detail: ${privateDetail}.`],
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({ question: 'What changed?', include_secure_local: true });

    expect(result.opsec.release_decision.decision).toBe('needs_approval');
    expect(result.opsec.release_decision.required_approval).toBe('s4_release');
    expect(result.opsec.release_decision.reasons).toContain('uncited_non_public_answer');
    expect(result.answer).not.toContain(privateDetail);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('strict mode restores needs_approval for unreleased secure facts', async () => {
    const { analyst } = scriptedAnalyst(
      citingFirstCandidate('Total testosterone was 612 ng/dL on 2025-04-22.', '612 ng/dL on 2025-04-22'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
      secureDerivativeDefault: 'approval',
    });

    const withheld = await handler.answer({ question: 'Latest testosterone?', include_secure_local: true });
    expect(withheld.opsec.release_decision.decision).toBe('needs_approval');
    expect(withheld.opsec.release_decision.required_approval).toBe('s4_release');
    expect(withheld.policy.secure_local_content_exposed).toBe(false);
    expect(withheld.evidence).toEqual([]);
    expect(withheld.answer).not.toContain('612');
    expect(JSON.stringify(withheld)).not.toContain('/files/lab-1.pdf');
    expect(JSON.stringify(withheld)).not.toContain('lab-1.pdf');
    expect(withheld.answer).not.toContain('SECURE-RAW-CHUNK-TEXT');

    const released = await handler.answer({
      question: 'Latest testosterone?',
      include_secure_local_content: true,
    });
    expect(released.opsec.release_decision.decision).toBe('allow');
    expect(released.evidence).toHaveLength(1);
  });

  // A model shown a mixed pack can state a Private fact while citing only a
  // Personal candidate. Gate facts come from citations, so without a pack-level
  // check every fact looks non-secure and strict mode would release it.
  test('strict mode gates an answer from a secure_local context even when it cites only non-secure evidence', async () => {
    const privateDetail = 'Total testosterone was 612 ng/dL';
    const { analyst, calls } = scriptedAnalyst((pack) => {
      const internalCandidate = pack.candidates.find((candidate) => candidate.trustDomain === 'internal')!;
      return {
        answer: `${privateDetail}, and the cholesterol note is on file.`,
        citations: [{ provenance: internalCandidate.provenance, claim: 'Cholesterol note is on file.' }],
        unanswered: [],
      };
    });
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['note-1'], secure: ['lab-1'] }),
      secureDerivativeDefault: 'approval',
    });

    const result = await handler.answer({ question: 'Latest labs?', include_secure_local: true });

    expect(calls[0]!.pack.candidates.some((candidate) => candidate.trustDomain === 'secure_local')).toBe(true);
    expect(result.opsec.release_decision.decision).toBe('needs_approval');
    expect(result.opsec.release_decision.required_approval).toBe('s4_release');
    expect(result.opsec.release_decision.reasons).toContain('secure_local_context_uncited_requires_approval');
    expect(result.evidence).toEqual([]);
    expect(result.policy.secure_local_content_exposed).toBe(false);
    expect(result.answer).not.toContain('612');
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  // The secure_local context rule is fail-closed and judged on the evidence
  // BUILD (EvidencePackBuildDetail.encounteredSecureLocal), not on what a leg
  // was shown. A build that met Private material holds the answer in strict
  // posture even when prompt fitting dropped that material or the prompt
  // format never rendered it: over-withholding there is accepted, leaking is
  // not. These tests run the real createAnalyst with a scripted model that
  // repeats whatever Private-derived text its own prompt shows.
  const citeInternal = (pack: EvidencePack): AnalystResult => {
    const internalCandidate = pack.candidates.find((candidate) => candidate.trustDomain === 'internal')!;
    return {
      answer: 'The cholesterol note is on file.',
      citations: [{ provenance: internalCandidate.provenance, claim: 'Cholesterol note is on file.' }],
      unanswered: [],
    };
  };

  const PRIVATE_TITLE_ID = 'Project-Nightingale-acquisition';
  const UPGRADED_ID = 'upgraded-private';

  // `secureMatchedItems` absent = the adapter does not report row sensitivity.
  function withMatchCount(
    adapter: SourceIndexCorpusSearchAdapter,
    matchedItems: number,
    secureMatchedItems?: number,
  ): SourceIndexCorpusSearchAdapter {
    return async (request) => ({
      ...(await adapter(request)),
      matchCount: {
        matchedItems,
        contentMatchedItems: matchedItems,
        saturated: false,
        ...(secureMatchedItems !== undefined ? { secureMatchedItems } : {}),
      },
    });
  }

  function privateCoverageLanes(input: { truncatedPrivate?: boolean; privateMatches?: number }) {
    const fixture = lanesFixture({ internal: ['note-1'], secure: [PRIVATE_TITLE_ID] });
    return {
      ...fixture,
      adapters: {
        ...fixture.adapters,
        ...(input.privateMatches !== undefined
          ? { [SECURE]: withMatchCount(adapterReturning([PRIVATE_TITLE_ID]), input.privateMatches) }
          : {}),
      } as SourceIndexRouterAdapterMap,
      contentProviders: {
        ...fixture.contentProviders,
        [SECURE]: {
          async fetchLocalContent() {
            return {
              sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
              chunks: [SECURE_SECRET],
              ...(input.truncatedPrivate ? { truncated: true } : {}),
            };
          },
        },
      } as LocalContentProviderMap,
    };
  }

  // A Personal corpus (OTHER) whose provider upgrades its item to a secure
  // sensitivity: S4/secure_local (B1, with a positive match count) or
  // S4/internal truncated (B2, a title-bearing gap).
  function upgradedCorpusLanes(input: { upgrade: 'secure_local' | 'secure_tier' }) {
    const fixture = lanesFixture({ internal: ['note-1'], other: [UPGRADED_ID] });
    return {
      ...fixture,
      adapters: {
        ...fixture.adapters,
        ...(input.upgrade === 'secure_local'
          ? { [OTHER]: withMatchCount(adapterReturning([UPGRADED_ID]), 7) }
          : {}),
      } as SourceIndexRouterAdapterMap,
      contentProviders: {
        ...fixture.contentProviders,
        [OTHER]: {
          async fetchLocalContent() {
            return input.upgrade === 'secure_local'
              ? {
                  sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                  chunks: [SECURE_SECRET],
                }
              : {
                  sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'internal' }),
                  chunks: [SECURE_SECRET],
                  truncated: true,
                };
          },
        },
      } as LocalContentProviderMap,
    };
  }

  // Cites candidate 1 (the Personal note) and repeats any Private-derived text
  // its own prompt shows, on the main call or only on the audit call.
  function echoingAnalyst(options: CreateAnalystOptions, echoOn: 'main' | 'audit' = 'main') {
    const requests: AnalystModelRequest[] = [];
    const analyst = createAnalyst({
      async complete(request) {
        requests.push(request);
        const echo = (echoOn === 'audit') === (requests.length > 1);
        const leaked = !echo ? '' : [
          request.prompt.includes(`${PRIVATE_TITLE_ID}.pdf`) ? ` See also ${PRIVATE_TITLE_ID}.pdf.` : '',
          request.prompt.includes(`${UPGRADED_ID}.pdf`) ? ` See also ${UPGRADED_ID}.pdf.` : '',
          /\(file\) 7 items/.test(request.prompt) ? ' You have 7 more matches.' : '',
        ].join('');
        return {
          modelId: 'scripted',
          text: JSON.stringify({
            answer: `The cholesterol note is on file.${leaked}`,
            citations: [{ evidence: 1, claim: 'Cholesterol note is on file.' }],
            unanswered: [],
            sufficient: true,
          }),
        };
      },
    }, options);
    return { analyst, requests };
  }

  const leakedText = (result: SourceIndexAnswerResult) => JSON.stringify({ answer: result.answer, evidence: result.evidence });

  function expectStrictHold(result: SourceIndexAnswerResult) {
    expect(result.opsec.release_decision.decision).toBe('needs_approval');
    expect(result.opsec.release_decision.required_approval).toBe('s4_release');
    expect(result.opsec.release_decision.reasons).toContain('secure_local_context_uncited_requires_approval');
    expect(result.evidence).toEqual([]);
  }

  function expectStrictRelease(result: SourceIndexAnswerResult) {
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.opsec.release_decision.reasons).not.toContain('secure_local_context_uncited_requires_approval');
    expect(result.opsec.release_decision.reasons).not.toContain('secure_local_context_uncited_derivative_allowed');
    expect(result.answer).toContain('The cholesterol note is on file.');
  }

  test('strict mode holds even when fitting dropped every Private candidate', async () => {
    const { analyst, calls } = scriptedAnalyst(citeInternal);
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['note-1'], secure: ['lab-1'] }),
      secureDerivativeDefault: 'approval',
      localAnalystPromptByteBudget: ONE_CANDIDATE_PROMPT_BYTES,
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.pack.candidates.map((candidate) => candidate.trustDomain)).toEqual(['internal']);
    expectStrictHold(result);
  });

  test('default mode records the uncited secure context even when fitting dropped every Private candidate', async () => {
    const { analyst, calls } = scriptedAnalyst(citeInternal);
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['note-1'], secure: ['lab-1'] }),
      localAnalystPromptByteBudget: ONE_CANDIDATE_PROMPT_BYTES,
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.pack.candidates.map((candidate) => candidate.trustDomain)).toEqual(['internal']);
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.opsec.release_decision.reasons).toContain('secure_local_context_uncited_derivative_allowed');
  });

  test('strict mode holds when a fitted pack keeps a Private item\'s extraction gap in the prompt', async () => {
    const { analyst, requests } = echoingAnalyst({});
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => privateCoverageLanes({ truncatedPrivate: true }),
      secureDerivativeDefault: 'approval',
      localAnalystPromptByteBudget: ONE_CANDIDATE_PROMPT_BYTES,
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).not.toContain('trust: secure_local/');
    expect(requests[0]!.prompt).toContain(`${PRIVATE_TITLE_ID}.pdf`);
    expectStrictHold(result);
    expect(leakedText(result)).not.toContain('Nightingale');
  });

  test('strict mode holds when only the audit prompt carries a Private item\'s extraction gap', async () => {
    const { analyst, requests } = echoingAnalyst({ evidenceFormat: 'compact', auditSuspiciousDrafts: true }, 'audit');
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => privateCoverageLanes({ truncatedPrivate: true }),
      secureDerivativeDefault: 'approval',
      localAnalystPromptByteBudget: ONE_CANDIDATE_PROMPT_BYTES,
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.prompt).not.toContain('Nightingale');
    expect(requests[1]!.prompt).toContain(`${PRIVATE_TITLE_ID}.pdf`);
    expectStrictHold(result);
    expect(leakedText(result)).not.toContain('Nightingale');
  });

  test('a fitted pack that keeps a Private match count is a secure context in both postures', async () => {
    const strict = echoingAnalyst({});
    const strictResult = await createAnalystSourceIndexAnswerHandler({
      analyst: strict.analyst,
      lanes: () => privateCoverageLanes({ privateMatches: 7 }),
      secureDerivativeDefault: 'approval',
      localAnalystPromptByteBudget: ONE_CANDIDATE_PROMPT_BYTES,
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(strict.requests[0]!.prompt).not.toContain('trust: secure_local/');
    expect(strict.requests[0]!.prompt).toMatch(/secure_local\.dropbox\.files \(file\) 7 items/);
    expectStrictHold(strictResult);
    expect(leakedText(strictResult)).not.toContain('7 more matches');

    const lenient = echoingAnalyst({});
    const defaultResult = await createAnalystSourceIndexAnswerHandler({
      analyst: lenient.analyst,
      lanes: () => privateCoverageLanes({ privateMatches: 7 }),
      localAnalystPromptByteBudget: ONE_CANDIDATE_PROMPT_BYTES,
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(defaultResult.opsec.release_decision.decision).toBe('allow');
    expect(defaultResult.opsec.release_decision.reasons).toContain('secure_local_context_uncited_derivative_allowed');
  });

  test('strict mode holds when the compact prompt (no audit) rendered no Private material at all', async () => {
    const { analyst, requests } = echoingAnalyst({ evidenceFormat: 'compact' });
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => privateCoverageLanes({ truncatedPrivate: true }),
      secureDerivativeDefault: 'approval',
      localAnalystPromptByteBudget: ONE_CANDIDATE_PROMPT_BYTES,
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).not.toContain('Nightingale');
    expect(requests[0]!.prompt).not.toContain('SECURE-RAW-CHUNK-TEXT');
    // Deliberate over-withholding: the build met Private material.
    expectStrictHold(result);
  });

  test('strict mode holds when a Personal corpus\'s item upgraded to secure_local leaves only its match count in the prompt', async () => {
    const { analyst, requests } = echoingAnalyst({});
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => upgradedCorpusLanes({ upgrade: 'secure_local' }),
      secureDerivativeDefault: 'approval',
      localAnalystPromptByteBudget: ONE_CANDIDATE_PROMPT_BYTES,
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).not.toContain('trust: secure_local/');
    expect(requests[0]!.prompt).toMatch(/internal\.other\.docs \(file\) 7 items/);
    expectStrictHold(result);
    expect(leakedText(result)).not.toContain('7 more matches');
  });

  test('strict mode holds when an S4 item in a Personal corpus leaves only its title-bearing gap in the prompt', async () => {
    const { analyst, requests } = echoingAnalyst({});
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => upgradedCorpusLanes({ upgrade: 'secure_tier' }),
      secureDerivativeDefault: 'approval',
      localAnalystPromptByteBudget: ONE_CANDIDATE_PROMPT_BYTES,
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).not.toContain('SECURE-RAW-CHUNK-TEXT');
    expect(requests[0]!.prompt).toContain(`${UPGRADED_ID}.pdf`);
    expectStrictHold(result);
    expect(leakedText(result)).not.toContain(UPGRADED_ID);
  });

  // The ChatGPT source_answer request shape (mcp-surface.ts): both Private
  // inclusion flags false. The Private corpus is skipped, so the build never
  // meets it and strict mode releases. (A provider upgrade of a Personal item
  // on this path would set the flag, correctly.)
  test('a Personal-only build that skipped the Private corpus releases in strict mode', async () => {
    const { analyst } = scriptedAnalyst(citeInternal);
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['note-1'], secure: ['lab-1'] }),
      secureDerivativeDefault: 'approval',
    }).answer({ question: 'Latest labs?', include_secure_local: false, include_secure_local_content: false });

    expect(result.audit.searched_corpora).not.toContain(SECURE);
    expect(result.audit.answer_synthesis.private_context_used).toBe(false);
    expectStrictRelease(result);
  });

  test('a Private corpus searched with no matches does not make a secure context', async () => {
    const { analyst } = scriptedAnalyst(citeInternal);
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const fixture = lanesFixture({ internal: ['note-1'] });
        return {
          ...fixture,
          adapters: { ...fixture.adapters, [SECURE]: withMatchCount(adapterReturning([]), 0) } as SourceIndexRouterAdapterMap,
        };
      },
      secureDerivativeDefault: 'approval',
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(result.audit.searched_corpora).toContain(SECURE);
    expectStrictRelease(result);
  });

  test('a Private corpus with a positive match count but no hit is a secure context', async () => {
    const { analyst } = scriptedAnalyst(citeInternal);
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const fixture = lanesFixture({ internal: ['note-1'] });
        return {
          ...fixture,
          adapters: { ...fixture.adapters, [SECURE]: withMatchCount(adapterReturning([]), 3) } as SourceIndexRouterAdapterMap,
        };
      },
      secureDerivativeDefault: 'approval',
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expectStrictHold(result);
  });

  // The router decides what a build met before its visibility gate, budget
  // or trim, so a secure contribution that never reaches hydration still
  // counts.
  test('strict mode holds when a trimmed Personal-corpus hit leaves an unclassified count in the prompt', async () => {
    let upgradeCalls = 0;
    const { analyst, requests } = echoingAnalyst({});
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const fixture = lanesFixture({ internal: ['note-1'], other: [UPGRADED_ID] });
        return {
          ...fixture,
          adapters: { ...fixture.adapters, [OTHER]: withMatchCount(adapterReturning([UPGRADED_ID]), 7) } as SourceIndexRouterAdapterMap,
          contentProviders: {
            ...fixture.contentProviders,
            [OTHER]: {
              async fetchLocalContent() {
                upgradeCalls += 1;
                return {
                  sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                  chunks: [SECURE_SECRET],
                };
              },
            },
          } as LocalContentProviderMap,
        };
      },
      secureDerivativeDefault: 'approval',
    }).answer({ question: 'Latest labs?', include_secure_local: true, max_results: 1 });

    expect(upgradeCalls).toBe(0);
    expect(requests[0]!.prompt).toMatch(/internal\.other\.docs \(file\) 7 items/);
    expectStrictHold(result);
    expect(leakedText(result)).not.toContain('7 more matches');
  });

  test('strict mode holds on a positive count from a Personal corpus whose default tier is secure', async () => {
    const { analyst, requests } = echoingAnalyst({});
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const fixture = lanesFixture({ internal: ['note-1'] });
        return {
          ...fixture,
          registry: buildSourceIndexCorpusRegistry([
            defineSourceIndexCorpus({ corpusId: INTERNAL, family: 'file', trustDomain: 'internal' }),
            defineSourceIndexCorpus({
              corpusId: OTHER,
              family: 'file',
              trustDomain: 'internal',
              defaultSensitivity: { trustTier: 'S4', trustDomain: 'internal' },
            }),
          ]),
          // Even a count that claims no secure rows: the corpus default rules.
          adapters: { ...fixture.adapters, [OTHER]: withMatchCount(adapterReturning([]), 7, 0) } as SourceIndexRouterAdapterMap,
        };
      },
      secureDerivativeDefault: 'approval',
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(requests[0]!.prompt).toMatch(/internal\.other\.docs \(file\) 7 items/);
    expectStrictHold(result);
    expect(leakedText(result)).not.toContain('7 more matches');
  });

  test('strict mode holds when the visibility gate removed the only Private hit', async () => {
    const { analyst, requests } = echoingAnalyst({});
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => ({
        ...lanesFixture({ internal: ['note-1'], secure: ['lab-1'] }),
        visibilityGate: (hits) => hits.filter((hit) => hit.trustDomain !== 'secure_local'),
      }),
      secureDerivativeDefault: 'approval',
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(requests[0]!.prompt).not.toContain('trust: secure_local/');
    expect(requests[0]!.prompt).not.toContain('lab-1');
    expectStrictHold(result);
  });

  test('strict mode holds when only a planner expansion met a positive Private count', async () => {
    const { analyst, requests } = echoingAnalyst({});
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const fixture = lanesFixture({ internal: ['note-1'] });
        const secure: SourceIndexCorpusSearchAdapter = async (request) => ({
          ...(await adapterReturning([])(request)),
          ...(request.query === 'acquisition plans'
            ? { matchCount: { matchedItems: 5, contentMatchedItems: 5, saturated: false } }
            : {}),
        });
        return { ...fixture, adapters: { ...fixture.adapters, [SECURE]: secure } as SourceIndexRouterAdapterMap };
      },
      queryPlanner: async () => ['acquisition plans'],
      secureDerivativeDefault: 'approval',
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expect(requests[0]!.prompt).not.toContain('secure_local.dropbox.files (file)');
    expectStrictHold(result);
  });

  test('a Personal-only answer with trimmed hits the store classified non-secure still releases in strict mode', async () => {
    const { analyst, requests } = echoingAnalyst({});
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const fixture = lanesFixture({ internal: ['note-1', 'note-2', 'note-3'] });
        return {
          ...fixture,
          adapters: {
            ...fixture.adapters,
            [INTERNAL]: withMatchCount(adapterReturning(['note-1', 'note-2', 'note-3']), 7, 0),
          } as SourceIndexRouterAdapterMap,
        };
      },
      secureDerivativeDefault: 'approval',
    }).answer({ question: 'Latest labs?', include_secure_local: true, max_results: 1 });

    expect(requests[0]!.prompt).toMatch(/internal\.notes\.docs \(file\) 7 items/);
    expectStrictRelease(result);
  });

  // The accepted cost of the fail-closed count rule: an adapter that counts
  // without reporting row sensitivity makes a positive count unknown, and
  // unknown is secure. (The connector store reports it for every count.)
  test('a positive Personal count with unreported row sensitivity holds in strict mode', async () => {
    const { analyst } = scriptedAnalyst(citeInternal);
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const fixture = lanesFixture({ internal: ['note-1'] });
        return {
          ...fixture,
          adapters: { ...fixture.adapters, [INTERNAL]: withMatchCount(adapterReturning(['note-1']), 4) } as SourceIndexRouterAdapterMap,
        };
      },
      secureDerivativeDefault: 'approval',
    }).answer({ question: 'Latest labs?', include_secure_local: true });

    expectStrictHold(result);
  });

  test('strict mode still releases the content-free unsupported answer from a secure_local context', async () => {
    const { analyst } = scriptedAnalyst(() => ({
      answer: 'No evidence in the sources answers this.',
      citations: [],
      unanswered: [],
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['note-1'], secure: ['lab-1'] }),
      secureDerivativeDefault: 'approval',
    });

    const result = await handler.answer({ question: 'Latest labs?', include_secure_local: true });

    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.opsec.release_decision.reasons).toContain('unsupported_answer_released_without_source_content');
    expect(result.answer).toContain('could not extract a cited bounded answer');
  });

  test('default mode releases an uncited-secure answer but the audit records the secure_local context', async () => {
    const { analyst } = scriptedAnalyst((pack) => {
      const internalCandidate = pack.candidates.find((candidate) => candidate.trustDomain === 'internal')!;
      return {
        answer: 'Total testosterone was 612 ng/dL, and the cholesterol note is on file.',
        citations: [{ provenance: internalCandidate.provenance, claim: 'Cholesterol note is on file.' }],
        unanswered: [],
      };
    });
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['note-1'], secure: ['lab-1'] }),
    });

    const result = await handler.answer({ question: 'Latest labs?', include_secure_local: true });

    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.opsec.release_decision.reasons).toContain('secure_local_context_uncited_derivative_allowed');
    expect(result.opsec.structured_evidence.every((item) => item.trust_domain !== 'secure_local')).toBe(true);
    expect(result.audit.answer_synthesis.private_context_used).toBe(true);
    expect(result.answer).toContain('612');
    expect(JSON.stringify(result.opsec)).not.toContain('612');
    expect(JSON.stringify(result.audit)).not.toContain('612');
  });

  test('selected secure-local item answers from the pinned evidence instead of neighboring search hits', async () => {
    let searchCalls = 0;
    const { analyst, calls } = scriptedAnalyst((pack) => {
      expect(pack.candidates).toHaveLength(1);
      expect(pack.candidates[0]!.provenance.sourceItem.providerItemId).toBe('lab-selected');
      expect(pack.candidates[0]!.chunks.join('\n')).toContain('SELECTED-LAB-VALUE 612');
      return {
        answer: 'The selected lab report says testosterone was 612 ng/dL.',
        citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'Testosterone was 612 ng/dL.' }],
        unanswered: [],
      };
    });
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const registry = buildSourceIndexCorpusRegistry([
          defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
        ]);
        const adapters = {
          [SECURE]: () => {
            searchCalls += 1;
            return adapterReturning(['lab-neighbor'])({
              query: 'testosterone',
              maxResults: 5,
              corpus: registry.get(SECURE)!,
              context: { allowedTrustDomains: ['secure_local'] },
            });
          },
        };
        const contentProviders = {
          [SECURE]: {
            async fetchLocalContent(request: LocalContentRequest) {
              return {
                sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                chunks: [`SELECTED-LAB-VALUE 612 from ${request.provenance.sourceItem.providerItemId}`],
                locatorUri: '/trusted/dropbox/lab-selected.pdf',
              };
            },
          },
        };
        return {
          registry,
          adapters: adapters as SourceIndexRouterAdapterMap,
          contentProviders: contentProviders as LocalContentProviderMap,
        };
      },
    });

    const result = await handler.answer({
      question: 'Analyze this selected lab report.',
      corpus_id: SECURE,
      selected_items: [{
        corpus_id: SECURE,
        family: 'file',
        provider: 'dropbox',
        account_scope: 'personal',
        provider_item_id: 'lab-selected',
        local_item_id: 'personal:lab-selected',
        provider_file_id: 'lab-selected',
        title: 'Forged selected lab report.pdf',
        uri: 'https://example.invalid/forged-lab-selected.pdf',
      }],
    });

    expect(searchCalls).toBe(0);
    expect(calls[0]!.options.localOnly).toBe(true);
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.policy.secure_local_content_exposed).toBe(true);
    expect(result.evidence).toEqual([expect.objectContaining({
      corpus_id: SECURE,
      provider_item_id: 'lab-selected',
      uri: '/trusted/dropbox/lab-selected.pdf',
    })]);
    expect(JSON.stringify(result)).not.toContain('Forged selected lab report');
    expect(JSON.stringify(result)).not.toContain('example.invalid');
    expect(JSON.stringify(result)).not.toContain('lab-neighbor');
    expect(JSON.stringify(result)).not.toContain('SELECTED-LAB-VALUE');
  });

  test('selected evidence reclassified as blocked is omitted without calling any analyst', async () => {
    let veniceCalls = 0;
    const local = scriptedAnalyst(() => {
      throw new Error('local analyst must not receive policy-denied evidence');
    });
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      veniceAnalyst: () => ({
        async analyze() {
          veniceCalls += 1;
          throw new Error('Venice must not receive policy-denied evidence');
        },
      }),
      lanes: () => {
        const registry = buildSourceIndexCorpusRegistry([
          defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
        ]);
        return {
          registry,
          adapters: {} as SourceIndexRouterAdapterMap,
          contentProviders: {
            [SECURE]: {
              async fetchLocalContent() {
                throw new SourceModelPolicyDeniedError('blocked_sensitive');
              },
            },
          } as LocalContentProviderMap,
        };
      },
    });

    const result = await handler.answer({
      question: 'Use Venice to analyze this exact selected report.',
      corpus_id: SECURE,
      analyst_provider: 'venice',
      selected_items: [{
        corpus_id: SECURE,
        family: 'file',
        provider: 'dropbox',
        account_scope: 'personal',
        provider_item_id: 'blocked-selected-item',
        local_item_id: 'personal:blocked-selected-item',
        title: 'Sensitive title must not survive policy denial.pdf',
      }],
    });

    expect(local.calls).toHaveLength(0);
    expect(veniceCalls).toBe(0);
    expect(result.evidence).toEqual([]);
    expect(result.answer).toContain('no matching evidence');
    expect(JSON.stringify(result)).not.toContain('blocked-selected-item');
    expect(JSON.stringify(result)).not.toContain('Sensitive title');
  });

  test('default hybrid retrieval preserves policy denial and bypasses every analyst route', async () => {
    for (const analystProvider of ['default', 'local', 'cloud', 'venice'] as const) {
      let veniceFactoryCalls = 0;
      let sovereigntyRouteCalls = 0;
      const local = scriptedAnalyst(() => {
        throw new Error('local analyst must not receive policy-denied evidence');
      });
      const cloud = scriptedAnalyst(() => {
        throw new Error('cloud analyst must not receive policy-denied evidence');
      });
      const venice = scriptedAnalyst(() => {
        throw new Error('Venice must not receive policy-denied evidence');
      });
      const handler = createAnalystSourceIndexAnswerHandler({
        analyst: local.analyst,
        cloudAnalyst: cloud.analyst,
        veniceAnalyst: () => {
          veniceFactoryCalls += 1;
          return venice.analyst;
        },
        sovereigntyAnalystRoute: () => {
          sovereigntyRouteCalls += 1;
          return [];
        },
        lanes: (request) => {
          const registry = buildSourceIndexCorpusRegistry([
            defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
          ]);
          return {
            registry,
            adapters: request.retrieval_mode === 'hybrid'
              ? { [SECURE]: adapterReturning(['blocked-hybrid-item']) } as SourceIndexRouterAdapterMap
              : { [SECURE]: adapterReturning(['untrusted-gap-item']) } as SourceIndexRouterAdapterMap,
            contentProviders: {
              [SECURE]: {
                async fetchLocalContent(contentRequest) {
                  if (contentRequest.provenance.sourceItem.providerItemId === 'blocked-hybrid-item') {
                    throw new SourceModelPolicyDeniedError('blocked_sensitive');
                  }
                  return {
                    sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                    chunks: [],
                    coverageGaps: [
                      'UNTRUSTED_POLICY_SUFFIX_INJECTION excluded one candidate from model use under current source policy.',
                    ],
                  };
                },
              },
            } as LocalContentProviderMap,
          };
        },
      });

      const result = await handler.answer({
        question: 'Analyze matching private reports.',
        analyst_provider: analystProvider,
        include_secure_local: true,
      });

      expect(local.calls).toHaveLength(0);
      expect(cloud.calls).toHaveLength(0);
      expect(venice.calls).toHaveLength(0);
      expect(veniceFactoryCalls).toBe(0);
      expect(sovereigntyRouteCalls).toBe(0);
      expect(result.answer).toContain('no matching evidence');
      expect(result.answer).toContain('excluded one candidate from model use under current source policy');
      expect(result.evidence).toEqual([]);
      expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
      expect(result.audit.lane_audits).toContainEqual(expect.objectContaining({
        laneName: 'source_answer:policy_filtered',
      }));
      expect(JSON.stringify(result)).not.toContain('blocked-hybrid-item');
      expect(JSON.stringify(result)).not.toContain('UNTRUSTED_POLICY_SUFFIX_INJECTION');
    }
  });

  test('S5 nested facts are hard-denied before any local or cloud analysis', async () => {
    let cloudCalls = 0;
    let veniceCalls = 0;
    const local = scriptedAnalyst(() => {
      throw new Error('local analyst must not receive S5 facts');
    });
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      cloudAnalyst: {
        async analyze() {
          cloudCalls += 1;
          throw new Error('standard cloud must not receive S5 facts');
        },
      },
      veniceAnalyst: () => ({
        async analyze() {
          veniceCalls += 1;
          throw new Error('Venice must not receive S5 facts');
        },
      }),
      lanes: () => {
        const registry = buildSourceIndexCorpusRegistry([
          defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
        ]);
        return {
          registry,
          adapters: { [SECURE]: adapterReturning(['fact-source']) } as SourceIndexRouterAdapterMap,
          contentProviders: {
            [SECURE]: {
              async fetchLocalContent(request: LocalContentRequest) {
                return {
                  sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                  chunks: ['ordinary S4 candidate text'],
                  facts: [createStructuredEvidenceFact({
                    factId: 'nested-s5',
                    claim: 'blocked nested fact',
                    sourceProvenance: [request.provenance],
                    sensitivity: buildSourceSensitivity({ trustTier: 'S5', trustDomain: 'secure_local' }),
                    confidence: 'high',
                    extractionKind: 'quoted_fact',
                  })],
                };
              },
            },
          } as LocalContentProviderMap,
        };
      },
    });

    for (const analystProvider of ['cloud', 'venice'] as const) {
      await expect(handler.answer({
        question: 'Analyze the private source.',
        include_secure_local: true,
        analyst_provider: analystProvider,
      })).rejects.toThrow('S5 source material is hard-denied');
    }
    expect(local.calls).toHaveLength(0);
    expect(cloudCalls).toBe(0);
    expect(veniceCalls).toBe(0);
  });

  test('selected item extraction failure reports a coverage gap without searching neighbors', async () => {
    let searchCalls = 0;
    const { analyst } = scriptedAnalyst((pack) => ({
      answer: 'I could not read the selected report well enough to answer.',
      citations: [],
      unanswered: pack.coverage.extractionGaps,
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const registry = buildSourceIndexCorpusRegistry([
          defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
        ]);
        return {
          registry,
          adapters: {
            [SECURE]: () => {
              searchCalls += 1;
              return adapterReturning(['lab-neighbor'])({
                query: 'testosterone',
                maxResults: 5,
                corpus: registry.get(SECURE)!,
                context: { allowedTrustDomains: ['secure_local'] },
              });
            },
          } as SourceIndexRouterAdapterMap,
          contentProviders: {
            [SECURE]: {
              async fetchLocalContent() {
                return undefined;
              },
            },
          } as LocalContentProviderMap,
        };
      },
    });

    const result = await handler.answer({
      question: 'What does this exact report say?',
      corpus_id: SECURE,
      selected_items: [{
        corpus_id: SECURE,
        family: 'file',
        provider: 'dropbox',
        account_scope: 'personal',
        provider_item_id: 'lab-selected',
        local_item_id: 'personal:lab-selected',
        title: 'Selected lab report.pdf',
      }],
    });

    expect(searchCalls).toBe(0);
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.answer).toContain('Coverage notes:');
    expect(result.answer).toContain('1 source item could not be read or extracted in this pass.');
    expect(result.answer).not.toContain('dropbox/file:lab-selected');
    expect(result.answer).not.toContain('no extractable content');
    expect(result.evidence).toEqual([expect.objectContaining({
      corpus_id: SECURE,
      trust_domain: 'secure_local',
      provider_item_id: 'lab-selected',
    })]);
    expect(JSON.stringify(result)).not.toContain('lab-neighbor');
  });

  test('selected metadata-only documents surface precise extraction coverage notes', async () => {
    const sensitiveTitle = 'Private testosterone legal report.pdf';
    const { analyst } = scriptedAnalyst((pack) => ({
      answer: 'I could not read the selected document well enough to answer.',
      citations: [],
      unanswered: pack.coverage.extractionGaps,
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const registry = buildSourceIndexCorpusRegistry([
          defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
        ]);
        return {
          registry,
          adapters: {
            [SECURE]: () => {
              throw new Error('selected evidence must not search neighboring items');
            },
          } as SourceIndexRouterAdapterMap,
          contentProviders: {
            [SECURE]: {
              async fetchLocalContent() {
                return {
                  sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                  chunks: [],
                  coverageGaps: [
                    'the PDF is metadata-only in the index; it may be scanned, rendered, image-only, or still awaiting OCR/VLM extraction.',
                  ],
                };
              },
            },
          } as LocalContentProviderMap,
        };
      },
    });

    const result = await handler.answer({
      question: 'What does this exact scanned report say?',
      corpus_id: SECURE,
      selected_items: [{
        corpus_id: SECURE,
        family: 'file',
        provider: 'dropbox',
        account_scope: 'personal',
        provider_item_id: 'scan-selected',
        local_item_id: 'personal:scan-selected',
        title: sensitiveTitle,
      }],
    });

    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.answer).toContain('Coverage notes:');
    expect(result.answer).toContain('1 source item could not be read or extracted in this pass.');
    expect(result.answer).not.toContain(sensitiveTitle);
    expect(result.answer).not.toContain('dropbox/file:scan-selected');
    expect(result.answer).not.toContain('metadata-only in the index');
    expect(result.answer).not.toContain('OCR/VLM extraction');
    expect(result.evidence).toEqual([expect.objectContaining({
      corpus_id: SECURE,
      trust_domain: 'secure_local',
      provider_item_id: 'scan-selected',
    })]);
  });

  test('matched failed-extraction file is surfaced as found but unreadable evidence', async () => {
    const { analyst } = scriptedAnalyst((pack) => ({
      answer: 'I could not answer because the matched document has no readable extracted text.',
      citations: [],
      unanswered: pack.coverage.extractionGaps,
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const registry = buildSourceIndexCorpusRegistry([
          defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
        ]);
        return {
          registry,
          adapters: {
            [SECURE]: () => ({
              hits: [{
                sourceItem: {
                  family: 'file',
                  provider: 'dropbox',
                  accountScope: 'personal',
                  providerItemId: 'id:lexidy-engagement',
                  providerFileId: 'id:lexidy-engagement',
                  localItemId: 'personal:id:lexidy-engagement',
                },
                provenance: {
                  sourceItem: {
                    family: 'file',
                    provider: 'dropbox',
                    accountScope: 'personal',
                    providerItemId: 'id:lexidy-engagement',
                    providerFileId: 'id:lexidy-engagement',
                    localItemId: 'personal:id:lexidy-engagement',
                  },
                  citation: { title: 'PT COMPANY | Pat Example.pdf' },
                },
                score: 1,
                rawExposed: false,
              }],
              latencyMs: 1,
              rawExposed: false,
            }),
          } as SourceIndexRouterAdapterMap,
          contentProviders: {
            [SECURE]: {
              async fetchLocalContent() {
                return {
                  sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                  chunks: [],
                  coverageGaps: ['content extraction failed.'],
                };
              },
            },
          } as LocalContentProviderMap,
        };
      },
    });

    const result = await handler.answer({
      question: 'Find the Lexidy engagement document.',
      corpus_id: SECURE,
      include_secure_local: true,
    });

    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.answer).toContain('I found matching source material');
    expect(result.answer).toContain('1 source item could not be read or extracted in this pass.');
    expect(result.evidence).toEqual([expect.objectContaining({
      corpus_id: SECURE,
      trust_domain: 'secure_local',
      provider_item_id: 'id:lexidy-engagement',
      provider_file_id: 'id:lexidy-engagement',
      title: 'PT COMPANY | Pat Example.pdf',
    })]);
    expect(result.policy.secure_local_content_exposed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('content extraction failed');
  });

  test('an insufficient local analyst escalation releases an honest gap instead of approval', async () => {
    const { analyst } = scriptedAnalyst((pack) => ({
      answer: 'Local evidence was insufficient to fully answer this securely.',
      citations: [],
      unanswered: ['exact value uncertain'],
      escalation: {
        reason: 'Local evidence was insufficient',
        redactedPack: { ...pack, candidates: [] },
      },
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: 'Summarize my secure lab.',
      include_secure_local_content: true,
    });

    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.opsec.release_decision.reasons).toContain('analyst_insufficient_no_source_content');
    expect(result.answer).toContain('could not extract a cited bounded answer');
    // The safe-unsupported release carries only the mechanical corpus-ids
    // note (2026-07-25): honest gap, no analyst-derived notes or content.
    expect(result.answer).toContain(
      'No citable supporting evidence could be released from the searched corpora',
    );
    expect(result.answer).not.toContain('exact value uncertain');
    expect(result.policy.secure_local_content_exposed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('self-heal rebuilds evidence once and analyst sees fresh chunks', async () => {
    let healed = false;
    let selfHealCalls = 0;
    const { analyst, calls } = scriptedAnalyst((pack) => ({
      answer: pack.candidates[0]?.chunks[0] ?? 'missing',
      citations: [{
        provenance: pack.candidates[0]!.provenance,
        claim: pack.candidates[0]?.chunks[0] ?? 'missing',
      }],
      unanswered: pack.coverage.extractionGaps,
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const registry = buildSourceIndexCorpusRegistry([
          defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
        ]);
        return {
          registry,
          adapters: {
            [SECURE]: adapterReturning(['dropbox-self-heal']),
          } as SourceIndexRouterAdapterMap,
          contentProviders: {
            [SECURE]: {
              async fetchLocalContent() {
                return {
                  sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                  chunks: healed ? ['fresh self-healed chunk'] : [],
                  coverageGaps: healed ? [] : ['document extraction is incomplete: bounded text was truncated.'],
                };
              },
            },
          } as LocalContentProviderMap,
        };
      },
      async selfHeal({ detail }) {
        selfHealCalls += 1;
        expect(detail.pack.candidates[0]?.chunks).toEqual([]);
        healed = true;
        return {
          healed: true,
          audit: {
            attempted: true,
            corpus_id: SECURE,
            provider_file_id_hash: 'hash-dropbox-self-heal',
            prior_state: {
              extraction_status: 'extracted',
              extraction_completeness: 'truncated',
            },
            action: 'forced_reextract',
            outcome: 'healed',
          },
        };
      },
    });

    const result = await handler.answer({
      question: 'What is in the self-healed document?',
      corpus_id: SECURE,
      include_secure_local: true,
    });

    expect(selfHealCalls).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.pack.candidates[0]!.chunks).toEqual(['fresh self-healed chunk']);
    expect(result.audit.self_heal).toMatchObject({
      attempted: true,
      outcome: 'healed',
      action: 'forced_reextract',
    });
    expect(result.answer).toContain('fresh self-healed chunk');
  });

  test('self-heal in-progress audit does not rebuild evidence and includes retry hint', async () => {
    let selfHealCalls = 0;
    const { analyst, calls } = scriptedAnalyst((pack) => ({
      answer: 'still incomplete',
      citations: [],
      unanswered: pack.coverage.extractionGaps,
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['dropbox-in-progress'] }),
      async selfHeal() {
        selfHealCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          healed: false,
          audit: {
            attempted: true,
            corpus_id: SECURE,
            provider_file_id_hash: 'hash-dropbox-in-progress',
            prior_state: {
              extraction_status: 'metadata_only',
              extraction_completeness: 'metadata_only',
            },
            action: 'forced_reextract',
            outcome: 'in_progress',
            retry_after_ms: 5000,
          },
        };
      },
    });

    const result = await handler.answer({
      question: 'What is in this file?',
      corpus_id: SECURE,
      include_secure_local: true,
    });

    expect(selfHealCalls).toBe(1);
    expect(calls).toHaveLength(1);
    expect(result.audit.self_heal).toMatchObject({
      attempted: true,
      outcome: 'in_progress',
      retry_after_ms: 5000,
    });
    expect(result.audit.phase_timings?.self_heal_ms).toBeGreaterThanOrEqual(15);
    expect(result.audit.phase_timings?.evidence_pack_ms ?? 0).toBeLessThan(
      result.audit.phase_timings?.self_heal_ms ?? 0,
    );
  });

  test('self-heal kill switch skips the hook', async () => {
    let selfHealCalls = 0;
    const { analyst } = scriptedAnalyst(() => ({
      answer: 'no self heal',
      citations: [],
      unanswered: [],
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['dropbox-kill-switch'] }),
      selfHealEnabled: false,
      async selfHeal() {
        selfHealCalls += 1;
        return {
          healed: true,
          audit: { attempted: true, outcome: 'healed' },
        };
      },
    });

    const result = await handler.answer({
      question: 'What is in this file?',
      corpus_id: SECURE,
      include_secure_local: true,
    });

    expect(selfHealCalls).toBe(0);
    expect(result.audit.self_heal).toBeUndefined();
  });

  test('an insufficient local analyst escalation scans unsupported coverage text', async () => {
    const leakedSecret = 'api_key = sk_live_abcdef1234567890abcdef';
    const { analyst } = scriptedAnalyst((pack) => ({
      answer: 'Local evidence was insufficient to fully answer this securely.',
      citations: [],
      unanswered: [`exact value uncertain ${leakedSecret}`],
      escalation: {
        reason: 'Local evidence was insufficient',
        redactedPack: { ...pack, candidates: [] },
      },
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: 'Summarize my secure lab.',
      include_secure_local_content: true,
    });

    expect(result.opsec.release_decision.decision).toBe('deny');
    expect(result.opsec.release_decision.required_approval).toBe('s5_secret_use');
    expect(result.opsec.release_decision.reasons).toContain('analyst_insufficient_no_source_content');
    expect(result.opsec.release_decision.reasons).toContain('s5_secret_denied_from_ordinary_output');
    expect(result.answer).not.toContain(leakedSecret);
    expect(JSON.stringify(result)).not.toContain(leakedSecret);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('a non-insufficiency analyst escalation still requires approval', async () => {
    const { analyst } = scriptedAnalyst((pack) => ({
      answer: 'Approval is required before this secure material can be summarized.',
      citations: [],
      unanswered: [],
      escalation: {
        reason: 'Approval required',
        redactedPack: { ...pack, candidates: [] },
      },
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: 'Summarize my secure lab.',
      include_secure_local_content: true,
    });

    expect(result.opsec.release_decision.decision).toBe('needs_approval');
    expect(result.opsec.release_decision.required_approval).toBe('s4_release');
    expect(result.opsec.release_decision.reasons).toContain('analyst_escalation_proposed');
    expect(result.policy.secure_local_content_exposed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('sanitizes non-public coverage notes before releasing a cited answer', async () => {
    const { analyst } = scriptedAnalyst(
      citingFirstCandidate('Found two readings.', 'two readings', ['2 scanned PDFs were not OCR-ed']),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
    });

    const result = await handler.answer({ question: 'How has my cholesterol changed?' });

    expect(result.answer).toContain('Coverage notes:');
    expect(result.answer).toContain(
      '1 non-public coverage gap affected this answer; raw filenames, paths, and source content were withheld.',
    );
    expect(result.answer).not.toContain('2 scanned PDFs were not OCR-ed');
    expect(result.opsec.release_decision.reasons).toContain('non_public_coverage_notes_sanitized');
  });

  test('releases only the category of a non-public extraction gap', async () => {
    const sensitiveGap = 'Private plan.pdf at /Users/sam/Health was not extracted.';
    const { analyst } = scriptedAnalyst((pack) => ({
      answer: 'The readable portion supports the bounded summary.',
      citations: [{
        provenance: pack.candidates[0]!.provenance,
        claim: 'bounded summary',
      }],
      unanswered: pack.coverage.extractionGaps,
    }));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const registry = buildSourceIndexCorpusRegistry([
          defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
        ]);
        return {
          registry,
          adapters: { [SECURE]: adapterReturning(['private-plan']) } as SourceIndexRouterAdapterMap,
          contentProviders: {
            [SECURE]: {
              async fetchLocalContent() {
                return {
                  sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                  chunks: ['The readable portion supports the bounded summary.'],
                  coverageGaps: [sensitiveGap],
                };
              },
            },
          } as LocalContentProviderMap,
        };
      },
    });

    const result = await handler.answer({
      question: 'Summarize the readable portion and report any gap.',
      corpus_id: SECURE,
      include_secure_local: true,
    });

    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.answer).toContain('non-public coverage and extraction/readability gap');
    expect(result.answer).toContain('raw filenames, paths, and source content were withheld');
    expect(result.answer).not.toContain('Private plan.pdf');
    expect(result.answer).not.toContain('/Users/sam/Health');
  });

  test('secure-local cited answers do not release file metadata from coverage gaps', async () => {
    const sensitiveTitle = 'Secret IVF plan - Sam private scan.pdf';
    const sensitiveProviderId = 'secure-failed-lab';
    const { analyst } = scriptedAnalyst(
      citingFirstCandidate(
        'Found a bounded lab summary.',
        'bounded lab summary',
        [`${sensitiveTitle} (${SECURE}) provider item ${sensitiveProviderId} OCR failed with private path /Users/sam/Health/${sensitiveTitle}`],
      ),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ secure: ['lab-1', sensitiveProviderId] }),
    });

    const result = await handler.answer({
      question: 'Summarize my secure local lab evidence.',
      include_secure_local: true,
    });

    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.answer).toContain('Found a bounded lab summary.');
    expect(result.answer).toContain(
      '1 non-public coverage gap affected this answer; raw filenames, paths, and source content were withheld.',
    );
    expect(result.answer).not.toContain(sensitiveTitle);
    expect(result.answer).not.toContain(sensitiveProviderId);
    expect(result.answer).not.toContain('/Users/sam/Health');
    expect(JSON.stringify(result)).not.toContain(sensitiveTitle);
    expect(JSON.stringify(result)).not.toContain(sensitiveProviderId);
  });

  test('coverage notes are scanned before a cited answer is released', async () => {
    const leakedSecret = 'api_key = sk_live_abcdef1234567890abcdef';
    const { analyst } = scriptedAnalyst(
      citingFirstCandidate('Found two readings.', 'two readings', [`2 scanned PDFs were not OCR-ed. ${leakedSecret}`]),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
    });

    const result = await handler.answer({ question: 'How has my cholesterol changed?' });

    expect(result.opsec.release_decision.decision).toBe('deny');
    expect(result.opsec.release_decision.required_approval).toBe('s5_secret_use');
    expect(result.answer).not.toContain(leakedSecret);
    expect(JSON.stringify(result)).not.toContain(leakedSecret);
  });

  test('excluding secure_local skips the corpus and reports it in the audit', async () => {
    const { analyst, calls } = scriptedAnalyst(
      citingFirstCandidate('Internal answer.', 'internal claim'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'], secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: 'What do my notes say?',
      include_secure_local: false,
    });

    const skipped = result.audit.skipped_corpora.find((s) => s.corpus_id === SECURE);
    expect(skipped?.reason).toBe('trust_domain_not_allowed');
    expect(result.audit.answer_synthesis.secure_local_items_consulted).toBe(0);
    expect(calls[0]!.options.localOnly).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('rejects an empty question', async () => {
    const { analyst } = scriptedAnalyst(citingFirstCandidate('x', 'y'));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
    });

    await expect(handler.answer({ question: '   ' })).rejects.toThrow('non-empty question');
  });
});

// A connector store's rows carry their own tier, which can be stricter than
// the store's default. Every lane's hit (keyword, semantic, recency) carries
// it to the router, which decides encounteredSecureLocal before any filter or
// trim; and an item no content provider answers for is judged by that tier,
// never by the lower store default. Real stores, real adapters.
describe('row tiers reach the secure_local context decision', () => {
  const STORE = 'internal.tiered.files';
  const CHAT = 'internal.tiered.chat';

  interface TieredItem { id: string; text: string; tier: SourceTrustTier; sentAt?: string }

  function tieredFileConnector(items: readonly TieredItem[]): SourceConnector {
    const rawItems = items.map((item): RawItem => ({
      identity: {
        family: 'file',
        provider: 'fixture',
        accountScope: 'personal',
        providerItemId: item.id,
        providerFileId: item.id,
        localItemId: `personal:${item.id}`,
        sourceVersion: `${item.id}:v1`,
      },
      mimeType: 'text/markdown',
      content: { kind: 'text', text: item.text },
      metadata: Object.freeze({ name: `${item.id}.md`, locatorUri: `/files/${item.id}.md`, updatedAt: '2026-10-01T10:00:00.000Z' }),
      fetchedAt: '2026-10-01T10:00:00.000Z',
    }));
    return {
      id: 'tiered.fixture',
      family: 'file',
      async authenticate() {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          yield { items: rawItems, done: true };
        })();
      },
      async fetchItem(localItemId: string): Promise<RawItem> {
        const item = rawItems.find((candidate) => candidate.identity.localItemId === localItemId);
        if (!item) throw new Error(`missing fixture ${localItemId}`);
        return item;
      },
      classificationSignals() {
        return {};
      },
    };
  }

  async function tieredStore(
    family: 'file' | 'chat',
    items: readonly TieredItem[],
  ): Promise<LocalConnectorStore> {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: family === 'chat' ? CHAT : STORE,
      family,
      trustDomain: 'internal',
    });
    const connector = family === 'chat'
      ? createWhatsAppFixtureConnector(items.map((item) => ({
          id: item.id,
          conversationId: 'family',
          text: item.text,
          sentAt: item.sentAt ?? '2026-10-01T10:00:00.000Z',
        })))
      : tieredFileConnector(items);
    const tiers = new Map(items.map((item) => [
      family === 'chat' ? `personal:family:${item.id}` : `personal:${item.id}`,
      item.tier,
    ] as const));
    await store.syncFromConnector(connector, {
      fetchContent: true,
      placement: (item: RawItem) => buildSourceSensitivity({
        trustTier: tiers.get(item.identity.localItemId) ?? 'S3',
        trustDomain: 'internal',
      }),
    });
    return store;
  }

  // Documents with "zebra" sit on the query's axis; anything else is
  // orthogonal. Not the built-in model, so no calibrated bar applies.
  const zebraProvider: SourceEmbeddingProvider = {
    provider: 'fixture',
    modelId: 'tiered-fixture-v1',
    dimension: 2,
    configHash: 'tiered-fixture',
    epochId: 'local:tiered-fixture-v1:2',
    backend: 'local',
    async embed(inputs, options) {
      return inputs.map((input) => (
        options.taskType === 'RETRIEVAL_QUERY' || input.text.includes('zebra') ? [1, 0] : [0, 1]
      ));
    },
  };

  function storeCorpus(store: LocalConnectorStore) {
    return defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: 'internal' });
  }

  async function route(
    store: LocalConnectorStore,
    query: string,
    options: {
      maxResults?: number;
      retrievalMode?: 'keyword' | 'hybrid';
      semanticRelevanceBar?: number;
      visibilityGate?: (hits: readonly SourceIndexRoutedSearchHit[]) => readonly SourceIndexRoutedSearchHit[];
      extra?: { corpusId: string; adapter: SourceIndexCorpusSearchAdapter };
    } = {},
  ) {
    const adapter = createConnectorStoreCorpusAdapter({
      store,
      retrievalMode: options.retrievalMode ?? 'keyword',
      ...(options.retrievalMode === 'hybrid' ? { embeddingProvider: zebraProvider } : {}),
      ...(options.semanticRelevanceBar !== undefined ? { semanticRelevanceBar: options.semanticRelevanceBar } : {}),
    });
    return routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([
        ...(options.extra ? [defineSourceIndexCorpus({ corpusId: options.extra.corpusId, family: 'file', trustDomain: 'internal' })] : []),
        storeCorpus(store),
      ]),
      adapters: {
        ...(options.extra ? { [options.extra.corpusId]: options.extra.adapter } : {}),
        [store.corpusId]: adapter,
      } as SourceIndexRouterAdapterMap,
      request: {
        query,
        maxResults: options.maxResults ?? 10,
        context: { allowedTrustDomains: ['internal'] },
      },
      ...(options.visibilityGate ? { visibilityGate: options.visibilityGate } : {}),
    });
  }

  const ids = (hits: readonly { sourceItem: { providerItemId: string } }[]) => hits.map((hit) => hit.sourceItem.providerItemId);

  test('every keyword hit carries its own row tier', async () => {
    const store = await tieredStore('file', [
      { id: 'plain', text: 'garden tomatoes', tier: 'S3' },
      { id: 'held', text: 'garden tomatoes again', tier: 'S4' },
    ]);
    try {
      const routed = await route(store, 'garden tomatoes');
      expect(Object.fromEntries(routed.hits.map((hit) => [hit.sourceItem.providerItemId, hit.trustTier]))).toEqual({ plain: 'S3', held: 'S4' });
      expect(routed.encounteredSecureLocal).toBe(true);
    } finally {
      store.close();
    }
  });

  test('a secure recency-lane hit sets the flag though the keyword count saw none', async () => {
    const store = await tieredStore('chat', [
      { id: 'match', text: 'garden tomatoes are ripe', tier: 'S3', sentAt: '2026-10-01T09:00:00.000Z' },
      { id: 'newest', text: 'unrelated private note', tier: 'S4', sentAt: '2026-10-01T11:00:00.000Z' },
    ]);
    try {
      const routed = await route(store, 'garden tomatoes');
      expect(ids(routed.hits)).toContain('newest');
      expect(routed.matchCounts?.[0]?.secureMatchedItems).toBe(0);
      expect(routed.encounteredSecureLocal).toBe(true);
    } finally {
      store.close();
    }
  });

  test('a secure semantic hit with no relevance bar sets the flag though it is not counted', async () => {
    const store = await tieredStore('file', [
      { id: 'plain', text: 'alpha notes', tier: 'S3' },
      { id: 'held', text: 'zebra private memo', tier: 'S4' },
    ]);
    try {
      await store.embedChunks({ provider: zebraProvider });
      const routed = await route(store, 'alpha', { retrievalMode: 'hybrid' });
      expect(ids(routed.hits)).toContain('held');
      expect(routed.matchCounts?.[0]).toMatchObject({ matchedItems: 1, secureMatchedItems: 0 });
      expect(routed.encounteredSecureLocal).toBe(true);
    } finally {
      store.close();
    }
  });

  test('a secure hit the visibility gate removes still sets the flag', async () => {
    const store = await tieredStore('chat', [
      { id: 'match', text: 'garden tomatoes are ripe', tier: 'S3', sentAt: '2026-10-01T09:00:00.000Z' },
      { id: 'newest', text: 'unrelated private note', tier: 'S4', sentAt: '2026-10-01T11:00:00.000Z' },
    ]);
    try {
      const routed = await route(store, 'garden tomatoes', {
        visibilityGate: (hits) => hits.filter((hit) => hit.sourceItem.providerItemId !== 'newest'),
      });
      expect(ids(routed.hits)).toEqual(['match']);
      expect(routed.encounteredSecureLocal).toBe(true);
    } finally {
      store.close();
    }
  });

  test('a secure hit the per-corpus budget trims still sets the flag', async () => {
    const store = await tieredStore('file', [{ id: 'held', text: 'zebra private memo', tier: 'S4' }]);
    try {
      await store.embedChunks({ provider: zebraProvider });
      const routed = await route(store, 'alpha', {
        retrievalMode: 'hybrid',
        maxResults: 1,
        extra: { corpusId: INTERNAL, adapter: adapterReturning(['note-1']) },
      });
      expect(ids(routed.hits)).toEqual(['note-1']);
      expect(routed.encounteredSecureLocal).toBe(true);
    } finally {
      store.close();
    }
  });

  test('a Personal-only store answer (every row S3) leaves the flag false', async () => {
    const store = await tieredStore('file', [
      { id: 'one', text: 'garden tomatoes', tier: 'S3' },
      { id: 'two', text: 'garden tomatoes again', tier: 'S3' },
    ]);
    try {
      const routed = await route(store, 'garden tomatoes', { maxResults: 1 });
      expect(routed.hits).toHaveLength(1);
      expect(routed.matchCounts?.[0]).toMatchObject({ matchedItems: 2, secureMatchedItems: 0 });
      expect(routed.encounteredSecureLocal).toBe(false);
    } finally {
      store.close();
    }
  });

  test('counts total and secure rows across lexical, overlapping and semantic-only matches', async () => {
    const store = await tieredStore('file', [
      { id: 'a', text: 'alpha zebra', tier: 'S3' },
      { id: 'b', text: 'alpha zebra too', tier: 'S4' },
      { id: 'c', text: 'zebra only', tier: 'S4' },
      { id: 'd', text: 'beta', tier: 'S3' },
    ]);
    try {
      await store.embedChunks({ provider: zebraProvider });
      const adapter = createConnectorStoreCorpusAdapter({
        store,
        retrievalMode: 'hybrid',
        embeddingProvider: zebraProvider,
        semanticRelevanceBar: 0.45,
      });
      const response = await adapter({
        query: 'alpha',
        maxResults: 10,
        corpus: storeCorpus(store),
        context: { allowedTrustDomains: ['internal'] },
      });
      expect(response.matchCount).toMatchObject({ matchedItems: 3, secureMatchedItems: 2, saturated: false });
    } finally {
      store.close();
    }
  });

  test('a saturated count reports its secure rows as a lower bound', async () => {
    const items: TieredItem[] = Array.from({ length: 60 }, (_, index) => ({
      id: `held-${index}`,
      text: `garden tomatoes ${index}`,
      tier: index % 2 === 0 ? 'S4' : 'S3',
    }));
    const store = await tieredStore('file', items);
    try {
      const routed = await route(store, 'garden tomatoes');
      const count = routed.matchCounts?.[0];
      expect(count?.saturated).toBe(true);
      expect(count?.secureMatchedItems).toBeGreaterThan(0);
      expect(count!.secureMatchedItems!).toBeLessThanOrEqual(count!.matchedItems);
      expect(routed.encounteredSecureLocal).toBe(true);
    } finally {
      store.close();
    }
  });

  // The store does not check a placement's tier on write; reading the row
  // back refuses it, so a search over it fails rather than counting the row
  // as non-secure or returning a hit with no usable tier.
  test('a row with an invalid tier is refused when read, never counted as non-secure', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: STORE, family: 'file', trustDomain: 'internal' });
    try {
      await store.syncFromConnector(tieredFileConnector([{ id: 'bad', text: 'garden tomatoes', tier: 'S3' }]), {
        fetchContent: true,
        placement: () => ({ ...buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }), trustTier: 'S9' as SourceTrustTier }),
      });
      await expect(route(store, 'garden tomatoes')).rejects.toThrow(/unknown trust tier/);
    } finally {
      store.close();
    }
  });

  // Real createAnalyst, scripted model that repeats a secure title it sees.
  function titleEchoAnalyst(title: string) {
    const requests: AnalystModelRequest[] = [];
    const analyst = createAnalyst({
      async complete(request) {
        requests.push(request);
        return {
          modelId: 'scripted',
          text: JSON.stringify({
            answer: `The garden note is on file.${request.prompt.includes(title) ? ` See also ${title}.` : ''}`,
            citations: [{ evidence: 1, claim: 'The garden note is on file.' }],
            unanswered: [],
            sufficient: true,
          }),
        };
      },
    });
    return { analyst, requests };
  }

  test('strict mode holds when the gate filtered a secure recency hit (repro A)', async () => {
    const store = await tieredStore('chat', [
      { id: 'match', text: 'garden tomatoes are ripe', tier: 'S3', sentAt: '2026-10-01T09:00:00.000Z' },
      { id: 'newest', text: 'unrelated private note', tier: 'S4', sentAt: '2026-10-01T11:00:00.000Z' },
    ]);
    try {
      const { analyst, requests } = titleEchoAnalyst('private note');
      const result = await createAnalystSourceIndexAnswerHandler({
        analyst,
        lanes: () => ({
          registry: buildSourceIndexCorpusRegistry([storeCorpus(store)]),
          adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword' }) },
          contentProviders: { [store.corpusId]: createConnectorStoreContentProvider({ store }) },
          visibilityGate: (hits) => hits.filter((hit) => hit.sourceItem.providerItemId !== 'newest'),
        }),
        secureDerivativeDefault: 'approval',
      }).answer({ question: 'garden tomatoes', retrieval_mode: 'keyword' });

      expect(requests[0]!.prompt).not.toContain('private note');
      expect(requests[0]!.prompt).not.toContain('/S4');
      expect(result.opsec.release_decision.decision).toBe('needs_approval');
      expect(result.opsec.release_decision.reasons).toContain('secure_local_context_uncited_requires_approval');
    } finally {
      store.close();
    }
  });

  test('strict mode holds when an S4 row\'s provider returns nothing and its title reaches the prompt (repro B)', async () => {
    const store = await tieredStore('file', [
      { id: 'plain', text: 'garden tomatoes', tier: 'S3' },
      { id: 'secret-merger', text: 'garden tomatoes merger', tier: 'S4' },
    ]);
    try {
      const { analyst, requests } = titleEchoAnalyst('secret-merger.md');
      const storeProvider = createConnectorStoreContentProvider({ store });
      const result = await createAnalystSourceIndexAnswerHandler({
        analyst,
        lanes: () => ({
          registry: buildSourceIndexCorpusRegistry([storeCorpus(store)]),
          adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword' }) },
          contentProviders: {
            [store.corpusId]: {
              async fetchLocalContent(request: LocalContentRequest) {
                return request.provenance.sourceItem.providerItemId === 'secret-merger'
                  ? undefined
                  : storeProvider.fetchLocalContent(request);
              },
            },
          } as LocalContentProviderMap,
        }),
        secureDerivativeDefault: 'approval',
      }).answer({ question: 'garden tomatoes', retrieval_mode: 'keyword' });

      expect(requests[0]!.prompt).toContain('secret-merger.md');
      // Fail-safe hydration: the unanswered item is judged by its own S4 tier.
      expect(requests[0]!.prompt).toContain('trust: internal/S4');
      expect(result.opsec.release_decision.decision).toBe('needs_approval');
      expect(result.opsec.release_decision.reasons).toContain('secure_local_context_uncited_requires_approval');
      expect(JSON.stringify({ answer: result.answer, evidence: result.evidence })).not.toContain('secret-merger');
    } finally {
      store.close();
    }
  });

  test('an item of unknown tier that no provider answers for makes a secure context', async () => {
    const { analyst } = scriptedAnalyst(citeFirstInternal);
    const result = await createAnalystSourceIndexAnswerHandler({
      analyst,
      lanes: () => {
        const fixture = lanesFixture({ internal: ['note-1'], other: ['unread-1'] });
        const { [OTHER]: _dropped, ...providers } = fixture.contentProviders as Record<string, unknown>;
        return { ...fixture, contentProviders: providers as LocalContentProviderMap };
      },
      secureDerivativeDefault: 'approval',
    }).answer({ question: 'Latest labs?' });

    expect(result.opsec.release_decision.decision).toBe('needs_approval');
    expect(result.opsec.release_decision.reasons).toContain('secure_local_context_uncited_requires_approval');
  });
});

function citeFirstInternal(pack: EvidencePack): AnalystResult {
  const internalCandidate = pack.candidates.find((candidate) => candidate.trustDomain === 'internal')!;
  return {
    answer: 'The cholesterol note is on file.',
    citations: [{ provenance: internalCandidate.provenance, claim: 'Cholesterol note is on file.' }],
    unanswered: [],
  };
}
