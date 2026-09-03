import { describe, expect, test } from 'bun:test';
import { createAnalyst, type AnalystModel } from '../src/core/analyst.ts';
import {
  buildEvidencePack,
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
import { SourceModelPolicyDeniedError } from '../src/core/source-model-policy.ts';

const INTERNAL = 'internal.dropbox.files';
const SECURE = 'secure_local.dropbox.health';

function registry() {
  return buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId: INTERNAL, family: 'file', trustDomain: 'internal' }),
    defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
  ]);
}

function adapterReturning(ids: string[]): SourceIndexCorpusSearchAdapter {
  return (request) => ({
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
    rawExposed: false as const,
  });
}

function provider(blocks: Record<string, LocalContentBlock | undefined>): LocalContentProvider {
  return {
    async fetchLocalContent(request) {
      return blocks[request.provenance.sourceItem.providerItemId];
    },
  };
}

const allowAll: SourceIndexSearchContext = { allowedTrustDomains: ['internal', 'secure_local', 'public_safe'] };

describe('buildEvidencePack', () => {
  test('assembles candidates with fetched local content and trust tags', async () => {
    const pack = await buildEvidencePack({
      question: 'What was my LDL?',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [INTERNAL]: adapterReturning(['doc-1']) } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [INTERNAL]: provider({
          'doc-1': { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: ['LDL 100 mg/dL'] },
        }),
      } as LocalContentProviderMap,
      now: () => new Date('2026-05-29T00:00:00.000Z'),
    });

    expect(pack.candidates).toHaveLength(1);
    expect(pack.candidates[0]!.chunks).toEqual(['LDL 100 mg/dL']);
    expect(pack.candidates[0]!.trustDomain).toBe('internal');
    expect(pack.candidates[0]!.trustTier).toBe('S2');
    expect(pack.coverage.searchedCorpora).toContain(INTERNAL);
    expect(pack.coverage.extractionGaps).toEqual([]);
    expect(pack.builtAt).toBe('2026-05-29T00:00:00.000Z');
  });

  // Regression for the 2026-07-05 "did I just get a whatsapp..." miss: the
  // chat phrasing of recency ("just got/received", "today", "N minutes ago")
  // must trigger temporal evidence ordering, not only recent/latest/newest.
  test('chat recency phrasings order evidence newest-first', async () => {
    const timedAdapter: SourceIndexCorpusSearchAdapter = () => ({
      hits: [
        {
          sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: 'old-strong', localItemId: 'old-strong' },
          provenance: {
            sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: 'old-strong', localItemId: 'old-strong' },
            citation: { title: 'old-strong', authoredAt: '2026-07-01T10:00:00.000Z' },
          },
          score: 0.9,
          rawExposed: false as const,
        },
        {
          sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: 'fresh-weak', localItemId: 'fresh-weak' },
          provenance: {
            sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: 'fresh-weak', localItemId: 'fresh-weak' },
            citation: { title: 'fresh-weak', authoredAt: '2026-07-05T22:08:31.000Z' },
          },
          score: 0.1,
          rawExposed: false as const,
        },
      ],
      latencyMs: 1,
      rawExposed: false as const,
    });
    const build = (question: string) => buildEvidencePack({
      question,
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [INTERNAL]: timedAdapter } as SourceIndexRouterAdapterMap,
      contentProviders: {} as LocalContentProviderMap,
    });

    for (const question of [
      'Did I just get a message with test in it?',
      'What arrived a few minutes ago?',
      'Did anything come in today?',
    ]) {
      const { candidates } = await build(question);
      expect(candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId))
        .toEqual(['fresh-weak', 'old-strong']);
    }

    // Non-temporal questions keep relevance order.
    const { candidates } = await build('Which document discusses the test plan?');
    expect(candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId))
      .toEqual(['old-strong', 'fresh-weak']);
  });

  test('reports an extraction gap when an item is located but unreadable', async () => {
    const pack = await buildEvidencePack({
      question: 'q',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [INTERNAL]: adapterReturning(['doc-1']) } as SourceIndexRouterAdapterMap,
      contentProviders: { [INTERNAL]: provider({ 'doc-1': undefined }) } as LocalContentProviderMap,
    });

    expect(pack.candidates[0]!.chunks).toEqual([]);
    // Trust tier falls back to the corpus default sensitivity (internal -> S3).
    expect(pack.candidates[0]!.trustTier).toBe('S3');
    expect(pack.coverage.extractionGaps.some((g) => g.includes('no extractable content'))).toBe(true);
  });

  test('reports a gap when a located corpus has no content provider', async () => {
    const pack = await buildEvidencePack({
      question: 'q',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [INTERNAL]: adapterReturning(['doc-1']) } as SourceIndexRouterAdapterMap,
      contentProviders: {} as LocalContentProviderMap,
    });

    expect(pack.coverage.extractionGaps.some((g) => g.includes('no local content provider'))).toBe(true);
  });

  test('drops policy-denied content before it can enter an EvidencePack', async () => {
    const deniedAdapter: SourceIndexCorpusSearchAdapter = () => ({
      hits: [{
        sourceItem: {
          family: 'file',
          provider: 'dropbox',
          accountScope: 'personal',
          providerItemId: 'blocked-file',
          localItemId: 'blocked-file',
        },
        score: 1,
        rawExposed: false,
      }],
      latencyMs: 1,
      laneAudits: [{
        laneName: 'blocked-file-title',
        laneType: 'x-blocked-file',
        candidateCount: 1,
        returnedCount: 1,
        skippedReason: 'blocked-file-reason',
        modelId: 'blocked-file-model',
        backend: 'blocked-file-backend',
        localOnly: true,
        rawExposed: false,
      }],
      rawExposed: false,
    });
    const detail = await buildEvidencePackDetailed({
      question: 'What does this selected private file say?',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [SECURE]: deniedAdapter } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [SECURE]: {
          async fetchLocalContent() {
            throw new SourceModelPolicyDeniedError('blocked_sensitive');
          },
        },
      } as LocalContentProviderMap,
    });

    const { pack } = detail;
    expect(pack.candidates).toEqual([]);
    expect(detail.candidateCorpusIds).toEqual([]);
    expect(detail.policyDeniedCandidates).toBe(1);
    expect(detail.policyDeniedCoverageGaps).toEqual([
      `${SECURE} excluded one candidate from model use under current source policy.`,
    ]);
    expect(detail.laneAudits).toEqual([{
      laneName: 'source_answer:policy_filtered',
      laneType: 'metadata',
      candidateCount: 1,
      returnedCount: 1,
      skippedReason: 'policy_filtered',
      localOnly: true,
      rawExposed: false,
    }]);
    expect(pack.coverage.searchedCorpora).toContain(SECURE);
    expect(pack.coverage.extractionGaps).toEqual([
      `${SECURE} excluded one candidate from model use under current source policy.`,
    ]);
    expect(JSON.stringify(pack)).not.toContain('blocked-file');
  });

  test('keeps safe evidence aligned when another candidate is policy-denied', async () => {
    const detail = await buildEvidencePackDetailed({
      question: 'What does the safe private file say?',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [SECURE]: adapterReturning(['blocked-file', 'safe-file']) } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [SECURE]: {
          async fetchLocalContent(request) {
            if (request.provenance.sourceItem.providerItemId === 'blocked-file') {
              throw new SourceModelPolicyDeniedError('blocked_sensitive');
            }
            return {
              sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
              chunks: ['The safe candidate says alpha.'],
            };
          },
        },
      } as LocalContentProviderMap,
    });

    expect(detail.pack.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId))
      .toEqual(['safe-file']);
    expect(detail.candidateCorpusIds).toEqual([SECURE]);
    expect(detail.policyDeniedCandidates).toBe(1);
    expect(detail.pack.coverage.extractionGaps).toEqual([
      `${SECURE} excluded one candidate from model use under current source policy.`,
    ]);
    expect(JSON.stringify(detail)).not.toContain('blocked-file');

    let modelCalls = 0;
    const result = await createAnalyst({
      async complete() {
        modelCalls += 1;
        return {
          text: JSON.stringify({
            answer: 'The safe candidate says alpha.',
            citations: [{ evidence: 1, claim: 'alpha' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'scripted',
        };
      },
    }).analyze(detail.pack, { localOnly: true });
    expect(modelCalls).toBe(1);
    expect(result.answer).toContain('alpha');
    expect(result.unanswered).toContain(
      `${SECURE} excluded one candidate from model use under current source policy.`,
    );
  });

  test('hard-denies provider-returned S5 content instead of treating it as an extraction gap', async () => {
    await expect(buildEvidencePack({
      question: 'What does this source say?',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [SECURE]: adapterReturning(['provider-leak']) } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [SECURE]: provider({
          'provider-leak': {
            sensitivity: buildSourceSensitivity({ trustTier: 'S5', trustDomain: 'secure_local' }),
            chunks: ['must never reach an EvidencePack'],
          },
        }),
      } as LocalContentProviderMap,
    })).rejects.toThrow('S5 source material is hard-denied');
  });

  test('tags secure_local content so the loop routes to the local analyst', async () => {
    const pack = await buildEvidencePack({
      question: 'Summarize my latest lab.',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [SECURE]: adapterReturning(['health-1']) } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [SECURE]: provider({
          'health-1': { sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }), chunks: ['Total testosterone 612 ng/dL'] },
        }),
      } as LocalContentProviderMap,
    });

    expect(pack.candidates.some((c) => c.trustDomain === 'secure_local')).toBe(true);
    expect(pack.candidates[0]!.trustTier).toBe('S4');
  });

  test('merges a provider-supplied locator into the candidate citation', async () => {
    const pack = await buildEvidencePack({
      question: 'Where is my lab report?',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [SECURE]: adapterReturning(['health-1']) } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [SECURE]: provider({
          'health-1': {
            sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
            chunks: ['Total testosterone 612 ng/dL'],
            locatorUri: '/Areas/Health/2025-04-22 lab.pdf',
          },
        }),
      } as LocalContentProviderMap,
    });

    expect(pack.candidates[0]!.provenance.citation?.uri).toBe('/Areas/Health/2025-04-22 lab.pdf');
    // The routed citation title is preserved alongside the merged locator.
    expect(pack.candidates[0]!.provenance.citation?.title).toBe('health-1');
  });

  test('rejects content providers that downgrade a routed trust domain', async () => {
    await expect(buildEvidencePack({
      question: 'Summarize my latest lab.',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [SECURE]: adapterReturning(['health-1']) } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [SECURE]: provider({
          'health-1': { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: ['Total testosterone 612 ng/dL'] },
        }),
      } as LocalContentProviderMap,
    })).rejects.toThrow('downgraded');
  });

  test('skipped corpora (disallowed trust domain) surface in coverage', async () => {
    const pack = await buildEvidencePack({
      question: 'q',
      maxResults: 10,
      searchContext: { allowedTrustDomains: ['internal'] },
      registry: registry(),
      adapters: {
        [INTERNAL]: adapterReturning(['doc-1']),
        [SECURE]: adapterReturning(['health-1']),
      } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [INTERNAL]: provider({ 'doc-1': { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: ['x'] } }),
      } as LocalContentProviderMap,
    });

    const skipped = pack.coverage.skippedCorpora.find((s) => s.corpusId === SECURE);
    expect(skipped?.reason).toBe('trust_domain_not_allowed');
    // The secure corpus was never searched, so its content was never fetched.
    expect(pack.candidates.every((c) => c.trustDomain !== 'secure_local')).toBe(true);
  });

  test('searches corpora and hydrates local content in parallel while preserving candidate order', async () => {
    const internalSearch = deferred<ReturnType<SourceIndexCorpusSearchAdapter>>();
    const secureSearch = deferred<ReturnType<SourceIndexCorpusSearchAdapter>>();
    const internalContent = deferred<LocalContentBlock>();
    const secureContent = deferred<LocalContentBlock>();
    const searchCalls: string[] = [];
    const contentCalls: string[] = [];

    const packPromise = buildEvidencePack({
      question: 'q',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [INTERNAL]: (request) => {
          searchCalls.push(request.corpus.corpusId);
          return internalSearch.promise;
        },
        [SECURE]: (request) => {
          searchCalls.push(request.corpus.corpusId);
          return secureSearch.promise;
        },
      } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [INTERNAL]: {
          fetchLocalContent(request) {
            contentCalls.push(request.provenance.sourceItem.providerItemId);
            return internalContent.promise;
          },
        },
        [SECURE]: {
          fetchLocalContent(request) {
            contentCalls.push(request.provenance.sourceItem.providerItemId);
            return secureContent.promise;
          },
        },
      } as LocalContentProviderMap,
    });

    await waitUntil(() => searchCalls.length === 2);
    internalSearch.resolve(adapterReturning(['doc-1'])({
      query: 'q',
      maxResults: 10,
      corpus: registry().get(INTERNAL)!,
      context: allowAll,
    }));
    secureSearch.resolve(adapterReturning(['health-1'])({
      query: 'q',
      maxResults: 10,
      corpus: registry().get(SECURE)!,
      context: allowAll,
    }));

    await waitUntil(() => contentCalls.length === 2);
    internalContent.resolve({
      sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
      chunks: ['internal chunk'],
    });
    secureContent.resolve({
      sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
      chunks: ['secure chunk'],
    });

    const pack = await packPromise;
    expect(searchCalls).toEqual([INTERNAL, SECURE]);
    expect(contentCalls).toEqual(['doc-1', 'health-1']);
    expect(pack.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId)).toEqual(['doc-1', 'health-1']);
    expect(pack.candidates.map((candidate) => candidate.chunks[0])).toEqual(['internal chunk', 'secure chunk']);
  });

  test('feeds a real Analyst end to end with cited content', async () => {
    const pack = await buildEvidencePack({
      question: 'What was my most recent total testosterone, and on what date?',
      maxResults: 10,
      searchContext: allowAll,
      registry: registry(),
      adapters: { [INTERNAL]: adapterReturning(['lab-2025']) } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [INTERNAL]: provider({
          'lab-2025': {
            sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
            chunks: ['Total testosterone 612 ng/dL, collected 2025-04-22.'],
          },
        }),
      } as LocalContentProviderMap,
    });

    const model: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'Your most recent total testosterone was 612 ng/dL on 2025-04-22.',
            citations: [{ evidence: 1, claim: '612 ng/dL on 2025-04-22' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'scripted',
        };
      },
    };
    const result = await createAnalyst(model).analyze(pack, { localOnly: false });

    expect(result.answer).toContain('612 ng/dL');
    expect(result.citations[0]!.provenance.sourceItem.providerItemId).toBe('lab-2025');
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not met');
}
