import { describe, expect, test } from 'bun:test';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
  type SourceIndexCorpusDefinition,
} from '../src/core/source-index/corpus.ts';
import {
  routeSourceIndexSearch,
  type SourceIndexCorpusSearchAdapter,
  type SourceIndexCorpusSearchResponse,
} from '../src/core/source-index/router.ts';

describe('source-index policy-aware router', () => {
  test('late-fuses only allowed trust-domain corpora', async () => {
    const corpora = fixtureCorpora();
    const registry = buildSourceIndexCorpusRegistry(corpora);
    const calls: string[] = [];
    const adapters = {
      'secure_local.email.private': adapterFor(calls, 'secure_local.email.private', 'email', 'email-1'),
      'internal.drive.docs': adapterFor(calls, 'internal.drive.docs', 'file', 'drive-1'),
      'public_safe.docs': adapterFor(calls, 'public_safe.docs', 'file', 'public-1'),
    };

    const result = await routeSourceIndexSearch({
      registry,
      adapters,
      request: {
        query: 'school visit policy',
        maxResults: 10,
        context: {
          allowedTrustDomains: ['secure_local', 'internal'],
          allowCloudQueries: true,
        },
      },
    });

    expect(calls.sort()).toEqual(['internal.drive.docs', 'secure_local.email.private']);
    expect(result.hits.map((hit) => hit.corpusId).sort()).toEqual(['internal.drive.docs', 'secure_local.email.private']);
    expect(result.skippedCorpora).toContainEqual({
      corpusId: 'public_safe.docs',
      trustDomain: 'public_safe',
      reason: 'trust_domain_not_allowed',
    });
    expect(result.corpusTimings).toHaveLength(2);
    expect(result.corpusTimings.every((timing) =>
      timing.outcome === 'success'
      && timing.elapsedMs >= 0
      && timing.adapterReportedMs === 2)).toBe(true);
    expect(result.rawExposed).toBe(false);
  });

  test('denies disallowed secure-local corpora before adapter invocation', async () => {
    const corpora = fixtureCorpora();
    const registry = buildSourceIndexCorpusRegistry(corpora);
    const calls: string[] = [];

    const result = await routeSourceIndexSearch({
      registry,
      adapters: {
        'secure_local.email.private': adapterFor(calls, 'secure_local.email.private', 'email', 'email-1'),
        'internal.drive.docs': adapterFor(calls, 'internal.drive.docs', 'file', 'drive-1'),
      },
      request: {
        query: 'private email deadline',
        maxResults: 5,
        context: {
          allowedTrustDomains: ['internal'],
          allowCloudQueries: true,
        },
      },
    });

    expect(calls).toEqual(['internal.drive.docs']);
    expect(result.hits.map((hit) => hit.corpusId)).toEqual(['internal.drive.docs']);
    expect(result.skippedCorpora).toContainEqual({
      corpusId: 'secure_local.email.private',
      trustDomain: 'secure_local',
      reason: 'trust_domain_not_allowed',
    });
  });

  test('requires explicit cloud-query permission before querying cloud-query-eligible corpora', async () => {
    const corpora = fixtureCorpora();
    const registry = buildSourceIndexCorpusRegistry(corpora);
    const calls: string[] = [];

    const result = await routeSourceIndexSearch({
      registry,
      adapters: {
        'secure_local.email.private': adapterFor(calls, 'secure_local.email.private', 'email', 'email-1'),
        'internal.drive.docs': adapterFor(calls, 'internal.drive.docs', 'file', 'drive-1'),
      },
      request: {
        query: 'drive planning note',
        maxResults: 5,
        context: {
          allowedTrustDomains: ['secure_local', 'internal'],
        },
      },
    });

    expect(calls).toEqual(['secure_local.email.private']);
    expect(result.skippedCorpora).toContainEqual({
      corpusId: 'internal.drive.docs',
      trustDomain: 'internal',
      reason: 'cloud_query_not_allowed',
    });
  });

  test('honors requested corpus and family filters before search', async () => {
    const corpora = fixtureCorpora();
    const registry = buildSourceIndexCorpusRegistry(corpora);
    const calls: string[] = [];

    const result = await routeSourceIndexSearch({
      registry,
      adapters: {
        'secure_local.email.private': adapterFor(calls, 'secure_local.email.private', 'email', 'email-1'),
        'internal.drive.docs': adapterFor(calls, 'internal.drive.docs', 'file', 'drive-1'),
      },
      request: {
        query: 'drive planning note',
        maxResults: 5,
        corpusIds: ['internal.drive.docs'],
        families: ['file'],
        context: {
          allowedTrustDomains: ['secure_local', 'internal'],
          allowCloudQueries: true,
        },
      },
    });

    expect(calls).toEqual(['internal.drive.docs']);
    expect(result.skippedCorpora).toContainEqual({
      corpusId: 'secure_local.email.private',
      trustDomain: 'secure_local',
      reason: 'not_requested',
    });
  });

  test('rejects raw source fields returned by adapters', async () => {
    const secureEmail = defineSourceIndexCorpus({
      corpusId: 'secure_local.email.private',
      family: 'email',
      trustDomain: 'secure_local',
    });
    const registry = buildSourceIndexCorpusRegistry([secureEmail]);

    await expect(
      routeSourceIndexSearch({
        registry,
        adapters: {
          'secure_local.email.private': async () =>
            ({
              hits: [{
                sourceItem: sourceItem('email', 'email-1'),
                rawExposed: false,
                snippet: 'raw-ish source packet text',
              }],
              latencyMs: 1,
              rawExposed: false,
            }) as unknown as SourceIndexCorpusSearchResponse,
        },
        request: {
          query: 'unsafe',
          maxResults: 5,
          context: { allowedTrustDomains: ['secure_local'] },
        },
      }),
    ).rejects.toThrow('forbidden raw field');
  });

  test('rejects normalized raw and credential-like fields returned by adapters', async () => {
    const secureEmail = defineSourceIndexCorpus({
      corpusId: 'secure_local.email.private',
      family: 'email',
      trustDomain: 'secure_local',
    });
    const registry = buildSourceIndexCorpusRegistry([secureEmail]);
    const forbiddenKeys = [
      'sourceText',
      'source_text',
      'rawSourceText',
      'approvedScopeKey',
      'accessToken',
    ];

    for (const key of forbiddenKeys) {
      await expect(
        routeSourceIndexSearch({
          registry,
          adapters: {
            'secure_local.email.private': async () =>
              ({
                hits: [{
                  sourceItem: sourceItem('email', 'email-1'),
                  rawExposed: false,
                  [key]: 'must not leave adapter output',
                }],
                latencyMs: 1,
                rawExposed: false,
              }) as unknown as SourceIndexCorpusSearchResponse,
          },
          request: {
            query: 'unsafe',
            maxResults: 5,
            context: { allowedTrustDomains: ['secure_local'] },
          },
        }),
      ).rejects.toThrow(`forbidden raw field "hits.0.${key}"`);
    }
  });
});

describe('source-index router per-lane retrieval deadline', () => {
  function twoPublicCorpora(): SourceIndexCorpusDefinition[] {
    return [
      defineSourceIndexCorpus({ corpusId: 'public_safe.fast', family: 'file', trustDomain: 'public_safe' }),
      defineSourceIndexCorpus({ corpusId: 'public_safe.slow', family: 'file', trustDomain: 'public_safe' }),
    ];
  }
  const context = { allowedTrustDomains: ['public_safe'] as const, allowCloudQueries: true };

  test('passes CPU-bound adapters a cooperative deadline before the authoritative timer', async () => {
    const registry = buildSourceIndexCorpusRegistry(twoPublicCorpora().slice(0, 1));
    let observedDeadlineAtMs: number | undefined;
    const startedAt = Date.now();
    await routeSourceIndexSearch({
      registry,
      laneTimeoutMs: 250,
      adapters: {
        'public_safe.fast': (request) => {
          observedDeadlineAtMs = request.deadlineAtMs;
          return { hits: [], latencyMs: 0, rawExposed: false };
        },
      },
      request: { query: 'q', maxResults: 5, context },
    });

    expect(observedDeadlineAtMs).toBeNumber();
    expect(observedDeadlineAtMs!).toBeGreaterThan(startedAt);
    expect(observedDeadlineAtMs!).toBeLessThanOrEqual(startedAt + 250);
  });

  test('drops a lane that blows the deadline, reports lane_timeout, and proceeds with the rest', async () => {
    const registry = buildSourceIndexCorpusRegistry(twoPublicCorpora());
    const calls: string[] = [];
    const result = await routeSourceIndexSearch({
      registry,
      laneTimeoutMs: 20,
      adapters: {
        'public_safe.fast': adapterFor(calls, 'public_safe.fast', 'file', 'fast-1'),
        // Never settles: the deadline must drop it, not the search hang on it.
        'public_safe.slow': () => new Promise<SourceIndexCorpusSearchResponse>(() => {}),
      },
      request: { query: 'q', maxResults: 5, context },
    });

    expect(calls).toEqual(['public_safe.fast']);
    expect(result.searchedCorpora).toEqual(['public_safe.fast']);
    expect(result.hits.map((hit) => hit.corpusId)).toEqual(['public_safe.fast']);
    expect(result.skippedCorpora).toContainEqual({
      corpusId: 'public_safe.slow',
      trustDomain: 'public_safe',
      reason: 'lane_timeout',
    });
    expect(result.rawExposed).toBe(false);
  });

  test('total fan-out time is bounded by the lane budget, not the slowest lane', async () => {
    const registry = buildSourceIndexCorpusRegistry(twoPublicCorpora());
    const calls: string[] = [];
    const startedAt = Date.now();
    const result = await routeSourceIndexSearch({
      registry,
      laneTimeoutMs: 20,
      adapters: {
        'public_safe.fast': adapterFor(calls, 'public_safe.fast', 'file', 'fast-1'),
        'public_safe.slow': () => new Promise<SourceIndexCorpusSearchResponse>(() => {}),
      },
      request: { query: 'q', maxResults: 5, context },
    });
    const elapsed = Date.now() - startedAt;

    // The slow lane would hang forever; bounded by the 20ms budget the whole
    // fan-out returns near-immediately (generous ceiling for CI jitter).
    expect(elapsed).toBeLessThan(2_000);
    expect(result.searchedCorpora).toEqual(['public_safe.fast']);
    expect(result.skippedCorpora.some((skip) => skip.reason === 'lane_timeout')).toBe(true);
  });

  test('a dropped lane that rejects AFTER the deadline never surfaces as an unhandled rejection', async () => {
    const registry = buildSourceIndexCorpusRegistry(twoPublicCorpora());
    const calls: string[] = [];
    const result = await routeSourceIndexSearch({
      registry,
      laneTimeoutMs: 5,
      adapters: {
        'public_safe.fast': adapterFor(calls, 'public_safe.fast', 'file', 'fast-1'),
        'public_safe.slow': () =>
          new Promise<SourceIndexCorpusSearchResponse>((_, reject) => {
            const timer = setTimeout(() => reject(new Error('late lane boom')), 30);
            timer.unref?.();
          }),
      },
      request: { query: 'q', maxResults: 5, context },
    });

    expect(result.skippedCorpora).toContainEqual({
      corpusId: 'public_safe.slow',
      trustDomain: 'public_safe',
      reason: 'lane_timeout',
    });
    // Let the late rejection fire; if it were not swallowed, bun would report an
    // unhandled rejection and fail the run.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(result.searchedCorpora).toEqual(['public_safe.fast']);
  });

  test('with a disabled deadline (<=0) a slow-but-finishing lane is NOT dropped', async () => {
    const registry = buildSourceIndexCorpusRegistry(twoPublicCorpora());
    const calls: string[] = [];
    const result = await routeSourceIndexSearch({
      registry,
      laneTimeoutMs: 0, // disabled -> unbounded lanes (pre-deadline behavior)
      adapters: {
        'public_safe.fast': adapterFor(calls, 'public_safe.fast', 'file', 'fast-1'),
        'public_safe.slow': async (request) => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return adapterFor(calls, 'public_safe.slow', 'file', 'slow-1')(request);
        },
      },
      request: { query: 'q', maxResults: 5, context },
    });

    expect([...result.searchedCorpora].sort()).toEqual(['public_safe.fast', 'public_safe.slow']);
    expect(result.skippedCorpora).toEqual([]);
  });

  test('fast lanes are unaffected: no lane_timeout under the default budget', async () => {
    const registry = buildSourceIndexCorpusRegistry(twoPublicCorpora());
    const calls: string[] = [];
    const result = await routeSourceIndexSearch({
      registry,
      adapters: {
        'public_safe.fast': adapterFor(calls, 'public_safe.fast', 'file', 'fast-1'),
        'public_safe.slow': adapterFor(calls, 'public_safe.slow', 'file', 'slow-1'),
      },
      request: { query: 'q', maxResults: 5, context },
    });

    expect([...result.searchedCorpora].sort()).toEqual(['public_safe.fast', 'public_safe.slow']);
    expect(result.skippedCorpora.some((skip) => skip.reason === 'lane_timeout')).toBe(false);
  });

  // Every corpus is its own lane and the candidate id is corpus-scoped, so each
  // rank tier is a total tie and the tie-break decides the whole cross-corpus
  // ranking. Adapter scores are adapter-local, so breaking that tie on them cut
  // the result by scoring convention: the corpus family emitting sub-lane RRF
  // sums lost every tier to the one emitting bm25-derived scores.
  test('the cross-corpus cut does not depend on adapter score scales', async () => {
    const survivorsFor = async (scores: Record<string, number>): Promise<string[]> => {
      const registry = buildSourceIndexCorpusRegistry(
        Object.keys(scores).map((corpusId) => defineSourceIndexCorpus({
          corpusId,
          family: 'file',
          trustDomain: 'internal',
        })),
      );
      const result = await routeSourceIndexSearch({
        registry,
        adapters: Object.fromEntries(Object.entries(scores).map(([corpusId, score]) => [
          corpusId,
          scoredAdapterFor(corpusId, score),
        ])),
        request: {
          query: 'q',
          // Below the corpus count, so the tie-break decides who is cut.
          maxResults: 2,
          context: { allowedTrustDomains: ['internal'] },
        },
      });
      return result.hits.map((hit) => hit.corpusId).sort();
    };

    const chatScoredLow = await survivorsFor({
      'internal.a.chat': 0.0164,
      'internal.b.files': 8,
      'internal.c.files': 7,
    });
    const chatScoredHigh = await survivorsFor({
      'internal.a.chat': 8,
      'internal.b.files': 0.0164,
      'internal.c.files': 0.0161,
    });

    expect(chatScoredLow).toHaveLength(2);
    expect(chatScoredLow).toEqual(chatScoredHigh);
  });

  // Same tie tier, the other bias: ordering it by corpus NAME made the cut a
  // function of spelling, so the alphabetically-last corpora were cut from
  // every answer forever (with 'i' < 's', that is every secure_local corpus in
  // the shipped registry). The surviving SET must depend on the lanes, not on
  // what they are called.
  test('the cross-corpus cut does not depend on corpus-id alphabetical order', async () => {
    const survivingLanePositions = async (corpusIds: readonly string[]): Promise<number[]> => {
      const registry = buildSourceIndexCorpusRegistry(
        corpusIds.map((corpusId) => defineSourceIndexCorpus({
          corpusId,
          family: 'file',
          trustDomain: 'internal',
        })),
      );
      const result = await routeSourceIndexSearch({
        registry,
        adapters: Object.fromEntries(corpusIds.map((corpusId) => [corpusId, scoredAdapterFor(corpusId, 1)])),
        request: {
          query: 'q',
          // Below the corpus count, so the tie-break decides who is cut.
          maxResults: 2,
          context: { allowedTrustDomains: ['internal'] },
        },
      });
      return result.hits
        .map((hit) => corpusIds.indexOf(hit.corpusId))
        .sort((left, right) => left - right);
    };

    // Identical lane set, identical hits, corpus ids permuted across the lanes.
    const ascending = await survivingLanePositions(['internal.a.chat', 'internal.b.files', 'internal.c.notes']);
    const descending = await survivingLanePositions(['internal.c.notes', 'internal.b.files', 'internal.a.chat']);

    expect(ascending).toEqual([0, 1]);
    expect(descending).toEqual([0, 1]);
  });

  // A corpus that searched fine, returned hits, and lost all of them to the
  // result budget is in searchedCorpora and (correctly) not in skippedCorpora,
  // so before this marker the caller had no way to tell the difference between
  // "that corpus had nothing" and "the budget never reached it".
  test('a corpus whose hits the result budget cut is reported as a degradation', async () => {
    const corpusIds = ['internal.a.chat', 'internal.b.files', 'internal.c.notes'];
    const registry = buildSourceIndexCorpusRegistry(
      corpusIds.map((corpusId) => defineSourceIndexCorpus({
        corpusId,
        family: 'file',
        trustDomain: 'internal',
      })),
    );

    const result = await routeSourceIndexSearch({
      registry,
      adapters: Object.fromEntries(corpusIds.map((corpusId) => [corpusId, scoredAdapterFor(corpusId, 1)])),
      request: { query: 'q', maxResults: 2, context: { allowedTrustDomains: ['internal'] } },
    });

    expect(result.hits).toHaveLength(2);
    expect([...result.searchedCorpora].sort()).toEqual(corpusIds);
    expect(result.skippedCorpora).toEqual([]);
    expect(result.degradations).toEqual([{
      laneName: 'internal.c.notes',
      laneType: 'keyword',
      reason: 'lane_budget_cut',
      occurrences: 1,
    }]);

    // A caller that asked for no candidates lost nothing to a budget, so that
    // is a scoping decision and not a degradation.
    const none = await routeSourceIndexSearch({
      registry,
      adapters: Object.fromEntries(corpusIds.map((corpusId) => [corpusId, scoredAdapterFor(corpusId, 1)])),
      request: { query: 'q', maxResults: 0, context: { allowedTrustDomains: ['internal'] } },
    });

    expect(none.hits).toEqual([]);
    expect(none.degradations).toEqual([]);
  });

  // Invariant pin for the budget cut: a corpus with several hits must not spend
  // the whole budget while another corpus that also matched contributes none.
  test('the result budget seats every corpus that returned a hit before seating seconds', async () => {
    const registry = buildSourceIndexCorpusRegistry([
      defineSourceIndexCorpus({ corpusId: 'internal.a.chat', family: 'file', trustDomain: 'internal' }),
      defineSourceIndexCorpus({ corpusId: 'internal.b.files', family: 'file', trustDomain: 'internal' }),
    ]);

    const result = await routeSourceIndexSearch({
      registry,
      adapters: {
        'internal.a.chat': multiHitAdapterFor('internal.a.chat', 4),
        'internal.b.files': multiHitAdapterFor('internal.b.files', 1),
      },
      request: { query: 'q', maxResults: 3, context: { allowedTrustDomains: ['internal'] } },
    });

    expect(result.hits).toHaveLength(3);
    expect([...new Set(result.hits.map((hit) => hit.corpusId))].sort())
      .toEqual(['internal.a.chat', 'internal.b.files']);
    expect(result.degradations).toEqual([]);
  });
});

function fixtureCorpora(): SourceIndexCorpusDefinition[] {
  return [
    defineSourceIndexCorpus({
      corpusId: 'secure_local.email.private',
      family: 'email',
      trustDomain: 'secure_local',
    }),
    defineSourceIndexCorpus({
      corpusId: 'internal.drive.docs',
      family: 'file',
      trustDomain: 'internal',
      activationMode: 'hybrid_primary',
      storageProfileInput: {
        cloudEmbeddingApproved: true,
        cloudQueryApproved: true,
      },
    }),
    defineSourceIndexCorpus({
      corpusId: 'public_safe.docs',
      family: 'file',
      trustDomain: 'public_safe',
      activationMode: 'hybrid_primary',
    }),
  ];
}

function adapterFor(
  calls: string[],
  corpusId: string,
  family: 'email' | 'file',
  providerItemId: string,
): SourceIndexCorpusSearchAdapter {
  return async (request): Promise<SourceIndexCorpusSearchResponse> => {
    calls.push(corpusId);
    return {
      hits: [{
        sourceItem: sourceItem(family, providerItemId),
        provenance: {
          sourceItem: sourceItem(family, providerItemId),
          providerIds: { provider_item_id: providerItemId },
          localIds: { corpus_id: request.corpus.corpusId },
          citation: { title: `Safe ${corpusId} citation` },
        },
        rawExposed: false,
      }],
      latencyMs: 2,
      laneAudits: [{
        laneName: `${corpusId}:fixture`,
        laneType: 'metadata',
        candidateCount: 1,
        returnedCount: 1,
        backend: 'fixture',
        localOnly: request.corpus.storageProfile.placement === 'local_private',
        rawExposed: false,
      }],
      rawExposed: false,
    };
  };
}

// One rank-1 hit carrying an adapter-local score, so a lane's whole
// contribution to the fusion is a single fully-tied candidate.
function scoredAdapterFor(corpusId: string, score: number): SourceIndexCorpusSearchAdapter {
  return async (): Promise<SourceIndexCorpusSearchResponse> => ({
    hits: [{
      sourceItem: sourceItem('file', `${corpusId}-1`),
      provenance: {
        sourceItem: sourceItem('file', `${corpusId}-1`),
        citation: { title: `Safe ${corpusId} citation` },
      },
      score,
      rawExposed: false,
    }],
    latencyMs: 1,
    laneAudits: [],
    rawExposed: false,
  });
}

// A lane that returns `count` ranked hits, so the budget cut has more than one
// candidate per corpus to choose between.
function multiHitAdapterFor(corpusId: string, count: number): SourceIndexCorpusSearchAdapter {
  return async (): Promise<SourceIndexCorpusSearchResponse> => ({
    hits: Array.from({ length: count }, (_unused, index) => ({
      sourceItem: sourceItem('file', `${corpusId}-${index + 1}`),
      provenance: {
        sourceItem: sourceItem('file', `${corpusId}-${index + 1}`),
        citation: { title: `Safe ${corpusId} citation ${index + 1}` },
      },
      rawExposed: false as const,
    })),
    latencyMs: 1,
    laneAudits: [],
    rawExposed: false,
  });
}

function sourceItem(family: 'email' | 'file', providerItemId: string) {
  return {
    family,
    provider: family === 'email' ? 'gmail' : 'gog-drive',
    accountScope: 'personal',
    providerItemId,
    localItemId: providerItemId,
  };
}
