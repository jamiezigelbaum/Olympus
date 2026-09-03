// P6-L4: the query planner races retrieval instead of taxing it.
//
// Before this leg the planner's local-model completion ran to completion BEFORE
// the first routed search, so every unpinned answer paid it serially — even the
// ones the literal query alone answered. These tests pin the new shape:
//
//   - planner and literal retrieval start together
//   - a STRONG literal run (>= maxResults hits) abandons the planner mid-flight
//   - a THIN literal run still awaits it and fuses exactly as before
//   - abandonment is safe: a late resolve or reject after the build returned
//     changes nothing and never escapes
//   - the latency trace says which of those happened, in counts only

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
import {
  createSourceAnswerTrace,
  observeSourceAnswerRetrievalAttempt,
  runWithSourceAnswerTrace,
  snapshotSourceAnswerTrace,
} from '../src/workers/source-index/answer-latency-trace.ts';

const CORPUS = 'internal.notes.docs';
const QUESTION = 'How do the 2024 and 2025 results compare?';
const EXPANSION = '2025 results';
const allowAll: SourceIndexSearchContext = {
  allowedTrustDomains: ['internal', 'secure_local', 'public_safe'],
};

function registry() {
  return buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId: CORPUS, family: 'file', trustDomain: 'internal' }),
  ]);
}

function adapterByQuery(
  idsByQuery: Record<string, string[]>,
  calls: string[],
): SourceIndexCorpusSearchAdapter {
  return (request) => {
    calls.push(request.query);
    const ids = idsByQuery[request.query] ?? [];
    return {
      hits: ids.map((id, index) => ({
        sourceItem: {
          family: 'file' as const,
          provider: 'notes',
          accountScope: 'personal',
          providerItemId: id,
          localItemId: id,
        },
        provenance: {
          sourceItem: {
            family: 'file' as const,
            provider: 'notes',
            accountScope: 'personal',
            providerItemId: id,
            localItemId: id,
          },
          citation: { title: id },
        },
        score: 1 - index * 0.1,
        rawExposed: false as const,
      })),
      latencyMs: 1,
      laneAudits: [],
      rawExposed: false as const,
    };
  };
}

function block(chunk: string): LocalContentBlock {
  return {
    sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
    chunks: [chunk],
  };
}

function providers(): LocalContentProviderMap {
  const provider: LocalContentProvider = {
    async fetchLocalContent(request) {
      return block(`content for ${request.provenance.sourceItem.providerItemId}`);
    },
  };
  return { [CORPUS]: provider } as LocalContentProviderMap;
}

// A planner whose completion the TEST controls. This is the strongest possible
// statement of "the literal run does not wait for it": the completion is still
// outstanding when the build returns, not merely slow.
function gatedPlanner(queries: readonly string[]) {
  let started = 0;
  let settled = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    get started() {
      return started;
    },
    get settled() {
      return settled;
    },
    release,
    planner: async (): Promise<readonly string[]> => {
      started += 1;
      await gate;
      settled = true;
      return queries;
    },
  };
}

function ids(detail: Awaited<ReturnType<typeof buildEvidencePackDetailed>>): string[] {
  return detail.pack.candidates.map((c) => c.provenance.sourceItem.providerItemId);
}

describe('evidence pack query-planner race', () => {
  test('a strong literal run answers without waiting for an outstanding planner', async () => {
    const calls: string[] = [];
    const gated = gatedPlanner([EXPANSION]);

    const detail = await buildEvidencePackDetailed({
      question: QUESTION,
      queryPlanner: gated.planner,
      maxResults: 2,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery(
          { [QUESTION]: ['doc-a', 'doc-b'], [EXPANSION]: ['doc-c'] },
          calls,
        ),
      } as SourceIndexRouterAdapterMap,
      contentProviders: providers(),
    });

    // The planner WAS kicked off (this is a race, not a disabled planner)...
    expect(gated.started).toBe(1);
    // ...and it was still outstanding when the answer path finished.
    expect(gated.settled).toBe(false);
    expect(calls).toEqual([QUESTION]);
    expect(ids(detail)).toEqual(['doc-a', 'doc-b']);

    // Let the abandoned completion settle; nothing observes it any more.
    gated.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gated.settled).toBe(true);
  });

  test('a slow planner does not add its delay to a strong literal run', async () => {
    // Timing-shaped: a deliberately slow planner, and an assertion that the
    // answer path returned on the literal run's schedule rather than the
    // planner's. The margin is deliberately wide — a fixture retrieval is
    // sub-millisecond, so the budget below is nearly all slack for a loaded
    // machine, and the only realistic way to blow it is to serialize on the
    // planner again.
    const PLANNER_DELAY_MS = 1_000;
    const LITERAL_BUDGET_MS = 300;
    let plannerSettled = false;
    const calls: string[] = [];

    const startedAt = Date.now();
    const detail = await buildEvidencePackDetailed({
      question: QUESTION,
      queryPlanner: async () => {
        await new Promise((resolve) => setTimeout(resolve, PLANNER_DELAY_MS));
        plannerSettled = true;
        return [EXPANSION];
      },
      maxResults: 2,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery(
          { [QUESTION]: ['doc-a', 'doc-b'], [EXPANSION]: ['doc-c'] },
          calls,
        ),
      } as SourceIndexRouterAdapterMap,
      contentProviders: providers(),
    });
    const elapsedMs = Date.now() - startedAt;

    expect(plannerSettled).toBe(false);
    expect(elapsedMs).toBeLessThan(LITERAL_BUDGET_MS);
    expect(calls).toEqual([QUESTION]);
    expect(ids(detail)).toEqual(['doc-a', 'doc-b']);
  });

  test('a thin literal run still waits for the planner before answering', async () => {
    const calls: string[] = [];
    const gated = gatedPlanner([EXPANSION]);

    const pending = buildEvidencePackDetailed({
      question: QUESTION,
      queryPlanner: gated.planner,
      maxResults: 4,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery(
          { [QUESTION]: ['doc-a'], [EXPANSION]: ['doc-b'] },
          calls,
        ),
      } as SourceIndexRouterAdapterMap,
      contentProviders: providers(),
    });

    // Let the literal run finish and the build reach its planner await. Polled
    // rather than slept so a loaded machine cannot turn this into a flake.
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    // The literal query ran; the build is now parked on the planner it cannot
    // skip, because one hit is thin against maxResults 4.
    expect(calls).toEqual([QUESTION]);
    expect(resolved).toBe(false);

    gated.release();
    const detail = await pending;
    expect(calls).toEqual([QUESTION, EXPANSION]);
    expect([...ids(detail)].sort()).toEqual(['doc-a', 'doc-b']);
  });

  test('an abandoned planner that rejects later never escapes the build', async () => {
    const calls: string[] = [];
    let rejected = false;

    const detail = await buildEvidencePackDetailed({
      question: QUESTION,
      queryPlanner: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        rejected = true;
        throw new Error('planner lane died after we walked away');
      },
      maxResults: 1,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery({ [QUESTION]: ['doc-a'] }, calls),
      } as SourceIndexRouterAdapterMap,
      contentProviders: providers(),
    });

    expect(calls).toEqual([QUESTION]);
    expect(ids(detail)).toEqual(['doc-a']);

    // Outlive the abandoned rejection: it must settle without surfacing.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(rejected).toBe(true);
  });

  test('an awaited planner that rejects still fails open to the literal run', async () => {
    const calls: string[] = [];
    const detail = await buildEvidencePackDetailed({
      question: QUESTION,
      queryPlanner: async () => {
        throw new Error('planner lane down');
      },
      maxResults: 4,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery({ [QUESTION]: ['doc-a'] }, calls),
      } as SourceIndexRouterAdapterMap,
      contentProviders: providers(),
    });

    expect(calls).toEqual([QUESTION]);
    expect(ids(detail)).toEqual(['doc-a']);
  });

  test('selected_items never consults the planner at all', async () => {
    let plannerCalls = 0;
    const calls: string[] = [];

    const detail = await buildEvidencePackDetailed({
      question: QUESTION,
      selectedItems: [{
        corpusId: CORPUS,
        sourceItem: {
          family: 'file',
          provider: 'notes',
          accountScope: 'personal',
          providerItemId: 'pinned-doc',
          localItemId: 'pinned-doc',
        },
      }],
      queryPlanner: async () => {
        plannerCalls += 1;
        return [EXPANSION];
      },
      maxResults: 4,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery({ [QUESTION]: ['doc-a'] }, calls),
      } as SourceIndexRouterAdapterMap,
      contentProviders: providers(),
    });

    expect(plannerCalls).toBe(0);
    expect(calls).toEqual([]);
    expect(ids(detail)).toEqual(['pinned-doc']);
  });
});

describe('evidence pack query-planner trace counters', () => {
  async function counters(input: {
    literalHits: string[];
    maxResults: number;
    queryPlanner: (question: string) => Promise<readonly string[]>;
  }) {
    const trace = createSourceAnswerTrace();
    await runWithSourceAnswerTrace(trace, () =>
      observeSourceAnswerRetrievalAttempt('keyword', () => buildEvidencePackDetailed({
        question: QUESTION,
        queryPlanner: input.queryPlanner,
        maxResults: input.maxResults,
        searchContext: allowAll,
        registry: registry(),
        adapters: {
          [CORPUS]: adapterByQuery(
            { [QUESTION]: input.literalHits, [EXPANSION]: ['doc-z'] },
            [],
          ),
        } as SourceIndexRouterAdapterMap,
        contentProviders: providers(),
      })));
    const snapshot = snapshotSourceAnswerTrace(trace);
    return {
      awaited: snapshot.queryPlannerAwaitedCount,
      ignored: snapshot.queryPlannerIgnoredAfterStrongLiteralCount,
      failed: snapshot.queryPlannerFailedCount,
    };
  }

  test('a strong literal run records the ignored disposition and no wait', async () => {
    expect(await counters({
      literalHits: ['doc-a', 'doc-b'],
      maxResults: 2,
      queryPlanner: async () => [EXPANSION],
    })).toEqual({ awaited: 0, ignored: 1, failed: 0 });
  });

  test('a thin literal run records the awaited disposition', async () => {
    expect(await counters({
      literalHits: ['doc-a'],
      maxResults: 4,
      queryPlanner: async () => [EXPANSION],
    })).toEqual({ awaited: 1, ignored: 0, failed: 0 });
  });

  test('a planner that throws while awaited records both awaited and failed', async () => {
    expect(await counters({
      literalHits: ['doc-a'],
      maxResults: 4,
      queryPlanner: async () => {
        throw new Error('planner lane down');
      },
    })).toEqual({ awaited: 1, ignored: 0, failed: 1 });
  });

  test('trace counters carry no query text', async () => {
    const trace = createSourceAnswerTrace();
    await runWithSourceAnswerTrace(trace, () => buildEvidencePackDetailed({
      question: QUESTION,
      queryPlanner: async () => [EXPANSION],
      maxResults: 4,
      searchContext: allowAll,
      registry: registry(),
      adapters: {
        [CORPUS]: adapterByQuery({ [QUESTION]: ['doc-a'], [EXPANSION]: ['doc-b'] }, []),
      } as SourceIndexRouterAdapterMap,
      contentProviders: providers(),
    }));

    const serialized = JSON.stringify(snapshotSourceAnswerTrace(trace));
    expect(serialized).not.toContain(QUESTION);
    expect(serialized).not.toContain(EXPANSION);
    expect(serialized).not.toContain('content for');
  });
});
