import { Database } from 'bun:sqlite';
import { registerLimit, initializeLimitStops, reportLimitStop, clearLimitStop, listOpenLimitStops } from '../src/core/limit-stops.ts';
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
  test('associates extraction gap indexes with candidates, leaving policy gaps unowned', async () => {
    const detail = await buildEvidencePackDetailed({
      question: 'project records', maxResults: 10, searchContext: allowAll, registry: registry(),
      adapters: { [INTERNAL]: adapterReturning(['denied', 'truncated', 'unreadable', 'readable']), [SECURE]: adapterReturning(['no-provider']) },
      contentProviders: { [INTERNAL]: { async fetchLocalContent(request) {
        const id = request.provenance.sourceItem.providerItemId;
        if (id === 'denied') throw new SourceModelPolicyDeniedError('blocked_sensitive');
        return { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
          chunks: id === 'unreadable' ? [] : ['Project record.'], truncated: id === 'truncated' };
      } } },
    });
    const owners = detail.candidateExtractionGapIndexes;
    expect(owners).toHaveLength(detail.pack.candidates.length);
    for (const [index, candidate] of detail.pack.candidates.entries()) {
      const id = candidate.provenance.sourceItem.providerItemId;
      const indexes = owners![index]!;
      expect(indexes).toHaveLength(id === 'readable' ? 0 : 1);
      for (const gapIndex of indexes) expect(detail.pack.coverage.extractionGaps[gapIndex]).toStartWith(`${id} (`);
    }
    const owned = new Set(owners!.flat());
    expect(detail.pack.coverage.extractionGaps.filter((_, index) => !owned.has(index)))
      .toEqual([`${INTERNAL} excluded one candidate from model use under current source policy.`]);
  });

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

  // A recency word in a question never reorders the pack (2026-11-11). The
  // pool used to be re-sorted newest-first whenever the question said recent,
  // latest, current or today: on a 24-seat pack that put a store's dated
  // items ahead of relevance, undid store turn and the reserved leader seats,
  // and a store's rank-1 answer fell to seat 15 or 20, past what a local
  // Analyst reads (held-out value-1 and value-2). Recency for chats lives in
  // the store (its newest messages are pinned into its results), and every
  // seat carries its date for the Analyst.
  test('a recency word does not reorder the pack', async () => {
    const timed = (corpusId: string, ids: Array<[string, string]>): SourceIndexCorpusSearchAdapter => () => ({
      hits: ids.map(([id, authoredAt]) => ({
        sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: id, localItemId: `${corpusId}:${id}` },
        provenance: {
          sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: id, localItemId: `${corpusId}:${id}` },
          citation: { title: id, authoredAt },
        },
        rawExposed: false as const,
      })),
      latencyMs: 1,
      rawExposed: false as const,
    });
    const build = (question: string) => buildEvidencePack({
      question,
      maxResults: 6,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [INTERNAL]: timed(INTERNAL, [['best-old', '2024-01-01T00:00:00.000Z'], ['i2', '2026-07-01T00:00:00.000Z'], ['i3', '2026-07-05T00:00:00.000Z']]),
        [SECURE]: timed(SECURE, [['s1', '2025-01-01T00:00:00.000Z'], ['s2', '2026-07-02T00:00:00.000Z'], ['s3', '2026-07-04T00:00:00.000Z']]),
      } as SourceIndexRouterAdapterMap,
      contentProviders: {} as LocalContentProviderMap,
    });
    const order = async (question: string) => (await build(question)).candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId);
    const plain = await order('What is the policy premium?');
    expect(plain[0]).toBe('best-old');
    for (const question of ['What is the current policy premium?', 'Did I just get the latest premium today?']) {
      expect(await order(question)).toEqual(plain);
    }
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
    // No provider answer and no tier on the hit: the item's tier is unknown,
    // so it is judged S4 in its corpus's domain, never the lower S3 default.
    expect(pack.candidates[0]!.trustTier).toBe('S4');
    expect(pack.candidates[0]!.trustDomain).toBe('internal');
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

 test('source limit gaps follow searched corpora, including another tier, and disappear on clear', async () => {
  const db = new Database(':memory:');
  initializeLimitStops(db);
  registerLimit({ id: 'coverage.limit', kind: 'requests', scope: 'source', label: 'Daily requests used', unit: 'requests', continue: 'run_once' });
  const stop = { id: 'coverage.limit', subject: JSON.stringify(['dropbox.files', 'public_safe.dropbox.files', 'pull']),
    since: '2026-11-12T12:00:00.000Z', limit: 1, used: 1 };
  const build = (corpusIds: string[]) => buildEvidencePack({
    question: 'project records', maxResults: 5, searchContext: allowAll, corpusIds,
    registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId: INTERNAL, family: 'file', trustDomain: 'internal' }),
      defineSourceIndexCorpus({ corpusId: 'internal.email', family: 'email', trustDomain: 'internal' })]),
    adapters: { [INTERNAL]: adapterReturning([]), 'internal.email': adapterReturning([]) }, contentProviders: {},
    limitStops: listOpenLimitStops(db),
  });
  try {
    reportLimitStop(stop, db);
    const gap = `Daily requests used since ${stop.since}; new items from this source may be missing from this answer`;
    expect((await build([INTERNAL])).coverage.extractionGaps).toContain(gap);
    // A different source was the only one searched.
    expect((await build(['internal.email'])).coverage.extractionGaps).not.toContain(gap);
    clearLimitStop(stop.id, stop.subject, db);
    expect((await build([INTERNAL])).coverage.extractionGaps).not.toContain(gap);
  } finally { db.close(); }
});
