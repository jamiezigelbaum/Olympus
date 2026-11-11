// A lane's best hit is never buried by fusion (#1230).
//
// Reproduces the 2026-11-10 eval finding without private data: the keyword
// lane put the one document holding the asked-for value at rank 1, the vector
// lane missed it, and the fused top 50 placed it at rank 30 to 36. Under RRF a
// candidate both lanes found at ANY depth up to 60 scores
// 1/(60+a) + 1/(60+b) >= 2/120, which beats a single-lane rank 1 (1/61). So
// every document both lanes merely touched went ahead of the keyword lane's
// clear winner, and the evidence pack (top 5) never saw it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import type { FusedRankedCandidate } from '../src/core/source-index/retrieval.ts';
import { RESERVED_LEADER_MIN_CONCEPT_SHARE, withReservedLeaderSeats } from '../src/core/source-index/retrieval.ts';
import { seatNameLeader, withLaneLeadersSeated } from '../src/workers/connector-store/local-index.ts';
import {
  LocalConnectorStore,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';
const CORPUS_ID = 'internal.fake.leader';

interface FixtureItem { id: string; name: string; text?: string }

// The answer: short, so bm25 ranks it first for the question's words.
const TARGET: FixtureItem = {
  id: 'target',
  name: 'renewal.txt',
  text: 'Harbor boat insurance renewal: policy number ZX-4471.',
};

// Forty longer notes that share the question's words. The vector lane finds
// them all (they sit on the query axis); the target sits off it.
const NEIGHBOURS: FixtureItem[] = Array.from({ length: 40 }, (_, index) => ({
  id: `note-${index}`,
  name: `note-${index}.txt`,
  text: `Marina log ${index}. Harbor boat insurance renewal came up again at the dock meeting; `
    + 'members compared notes on weather, fuel, mooring fees, winter storage, hull cleaning and paint '
    + `schedules, and agreed to revisit item ${index} next season after the survey.`,
}));

describe('connector-store fusion keeps each lane\'s best hit', () => {
  test('a keyword rank-1 hit the vector lane missed stays in the top 5', async () => {
    await withStore(async (store, provider) => {
      const keyword = await search(store, 'harbor boat insurance renewal', { retrievalMode: 'keyword', maxResults: 5 });
      // Precondition: the keyword lane alone ranks the target first.
      expect(hitIds(keyword)[0]).toBe('target');

      const hybrid = await search(store, 'harbor boat insurance renewal', {
        retrievalMode: 'hybrid', maxResults: 5, provider, semanticRelevanceBar: 0.62,
      });
      expect(hitIds(hybrid)).toContain('target');
      // Each lane reports its own wall time, so a slow lane is named.
      for (const laneType of ['keyword', 'semantic']) {
        expect(typeof hybrid.laneAudits?.find((lane) => lane.laneType === laneType)?.elapsedMs).toBe('number');
      }
    });
  });

  test('a vetted vector rank-1 hit the keyword lane missed stays in the top 5', async () => {
    await withStore(async (store, provider) => {
      // "vessel cover" shares no word with any note; only the vector lane
      // finds the target (query on the target's axis), while "harbor" keeps
      // the forty notes in the keyword lane.
      const hybrid = await search(store, 'harbor vessel cover', {
        retrievalMode: 'hybrid', maxResults: 5, provider, semanticRelevanceBar: 0.62,
      });
      expect(hitIds(hybrid)).toContain('target');
    });
  });

  test('fusion order among the rest is unchanged: dual-lane notes still lead the remainder', async () => {
    await withStore(async (store, provider) => {
      const hybrid = hitIds(await search(store, 'harbor boat insurance renewal', {
        retrievalMode: 'hybrid', maxResults: 5, provider, semanticRelevanceBar: 0.62,
      }));
      expect(hybrid.length).toBe(5);
      expect(hybrid.filter((id) => id !== 'target').every((id) => id.startsWith('note-'))).toBe(true);
    });
  });
});

describe('lane leader seats', () => {
  // Fused order [A, B, K, V]: K leads the keyword lane (already third), V
  // leads the vector lane (buried). V takes B's seat, not K's (#1231 review).
  const candidate = (id: string, ranks: Record<string, number>) => ({
    id, score: 0, laneRanks: new Map(Object.entries(ranks)),
    item: { sourceItem: { localItemId: id } },
  }) as unknown as FusedRankedCandidate<never>;
  const order = (vetted: string[]) => withLaneLeadersSeated([
    candidate('A', { keyword: 2, vector: 2 }),
    candidate('B', { keyword: 3, vector: 3 }),
    candidate('K', { keyword: 1 }),
    candidate('V', { vector: 1 }),
  ] as never, new Set(vetted)).map((entry) => String(entry.id));

  test('a buried leader evicts a non-leader, never a seated leader', () => {
    expect(order(['V'])).toEqual(['A', 'K', 'V', 'B']);
  });

  test('an unvetted vector leader gets no seat', () => {
    expect(order([])).toEqual(['A', 'B', 'K', 'V']);
  });
});

// gap-1 (Sparta probe 2026-11-11): the keyword lane seats the best name match
// right after the best readable partial match (#1287), but hybrid output
// buried it. Readable notes the vector lane vets count as complete there, and
// a names-only file has no chunks, so no vector hit can vet it: every vetted
// note went ahead of it and the store's top results never held the file named
// for the question.
const LANTERN: FixtureItem = { id: 'lantern', name: 'Harbor Lantern Restoration Quote.pdf' };
const LANTERN_NOTES: FixtureItem[] = Array.from({ length: 6 }, (_, index) => ({
  id: `lantern-note-${index}`,
  name: `crew-log-${index}.txt`,
  text: `Crew log ${index}. Harbor lantern restoration: the crew compared brass polish, glass panes, `
    + `wick holders and paint for the old lantern and agreed to look again at item ${index} next week.`,
}));

describe('hybrid output keeps the keyword lane\'s name leader', () => {
  const QUESTION = 'harbor lantern restoration estimate';

  test('the keyword lane seats the names-only leader second (precondition)', async () => {
    await withStore(async (store) => {
      const keyword = hitIds(await search(store, QUESTION, { retrievalMode: 'keyword', maxResults: 2 }));
      expect(keyword[0]).not.toBe('lantern');
      expect(keyword[1]).toBe('lantern');
    }, [LANTERN, ...LANTERN_NOTES]);
  });

  test('vetted vector notes do not push the names-only leader out of the top results', async () => {
    await withStore(async (store, provider) => {
      const hybrid = await search(store, QUESTION, {
        retrievalMode: 'hybrid', maxResults: 5, provider, semanticRelevanceBar: 0.62,
      });
      const ids = hitIds(hybrid);
      // A readable note still takes the first seat; the file named for the question takes the next.
      expect(ids[0]).toStartWith('lantern-note-');
      expect(ids[1]).toBe('lantern');
    }, [LANTERN, ...LANTERN_NOTES]);
  });

  test('with one seat, a readable note keeps it', async () => {
    await withStore(async (store, provider) => {
      const ids = hitIds(await search(store, QUESTION, {
        retrievalMode: 'hybrid', maxResults: 1, provider, semanticRelevanceBar: 0.62,
      }));
      expect(ids).toHaveLength(1);
      expect(ids[0]).toStartWith('lantern-note-');
    }, [LANTERN, ...LANTERN_NOTES]);
  });
});

// A store's keyword leader keeps a place in that store's hybrid result, with
// or without content (rerun 19, 2026-11-11): the lane's best hit matched only
// part of the question, so every vetted vector hit (complete in the final
// tiers) went ahead of it and the store's top results left it out.
describe('a store\'s keyword leader keeps a place in its hybrid result', () => {
  test('a readable partial-match leader the vector lane missed (value-2 shape)', async () => {
    await withStore(async (store, provider) => {
      // "premium" is in no note, so no row matches the whole question.
      const question = 'harbor boat insurance renewal premium';
      const keyword = hitIds(await search(store, question, { retrievalMode: 'keyword', maxResults: 5 }));
      expect(keyword[0]).toBe('target');
      const hybrid = hitIds(await search(store, question, {
        retrievalMode: 'hybrid', maxResults: 5, provider, semanticRelevanceBar: 0.62,
      }));
      expect(hybrid).toHaveLength(5);
      expect(hybrid).toContain('target');
    });
  });

  test('a names-only leader is not pushed out by a whole-question match ranked below the cut (gap-1 shape)', async () => {
    // Names alone match the whole question, and the file has no text: the
    // final tiers put it after every vetted note, and the name leader after it.
    const ESTIMATE: FixtureItem = { id: 'estimate', name: 'Harbor Lantern Restoration Estimate.pdf' };
    await withStore(async (store, provider) => {
      const question = 'harbor lantern restoration estimate';
      const hybrid = hitIds(await search(store, question, {
        retrievalMode: 'hybrid', maxResults: 5, provider, semanticRelevanceBar: 0.62,
      }));
      expect(hybrid).toHaveLength(5);
      expect(hybrid[0]).toStartWith('lantern-note-');
      expect(hybrid).toContain('estimate');
    }, [ESTIMATE, LANTERN, ...LANTERN_NOTES]);
  });
});

describe('a store marks its keyword leaders for the pack', () => {
  test('the keyword lane\'s first row carries its kind and concept share', async () => {
    const ESTIMATE: FixtureItem = { id: 'estimate', name: 'Harbor Lantern Restoration Estimate.pdf' };
    await withStore(async (store, provider) => {
      const hybrid = await search(store, 'harbor lantern restoration estimate', {
        retrievalMode: 'hybrid', maxResults: 5, provider, semanticRelevanceBar: 0.62,
      });
      const marked = hybrid.hits.filter((hit) => hit.keywordLeader);
      const estimate = marked.find((hit) => hit.sourceItem.providerItemId === 'estimate');
      // The text-less file names every concept, so the keyword lane leads with it.
      expect(estimate?.keywordLeader).toEqual({ kinds: ['keyword_first'], conceptShare: 1 });
      // Only leaders are marked.
      expect(marked.length).toBeLessThanOrEqual(2);
    }, [ESTIMATE, LANTERN, ...LANTERN_NOTES]);
  });
});

// The pack keeps the strongest keyword leaders across stores (#1350): store
// turn gives each store its first rank or two, so a store's leader sitting
// lower never reached the Analyst (rerun 20, 2026-11-11).
describe('reserved leader seats in the pack', () => {
  type Hit = { id: string; corpusId: string; keywordLeader?: { kinds: Array<'keyword_first' | 'name'>; conceptShare: number } };
  const hit = (id: string, corpusId: string, leader?: Hit['keywordLeader']): Hit => ({ id, corpusId, ...(leader ? { keywordLeader: leader } : {}) });
  const seat = (pool: Hit[], budgetedIds: string[], budget: number) => {
    const byId = new Map(pool.map((h) => [h.id, h]));
    const result = withReservedLeaderSeats({ hits: budgetedIds.map((id) => byId.get(id)!), degradations: [] }, pool, budget);
    return { ids: result.hits.map((h) => h.id), degradations: result.degradations };
  };

  test('seat 2 takes the keyword leader with the largest share, seat 3 the best names-only match', () => {
    const pool = [
      hit('a1', 'A', { kinds: ['keyword_first'], conceptShare: 0.6 }), hit('b1', 'B'), hit('c1', 'C'),
      hit('a2', 'A'), hit('b2', 'B', { kinds: ['keyword_first'], conceptShare: 0.8 }), hit('c2', 'C'),
      hit('a3', 'A'), hit('c3', 'C', { kinds: ['name'], conceptShare: 1 }),
    ];
    // Store turn seated a1 b1 c1 a2 b2; the names-only c3 was cut.
    expect(seat(pool, ['a1', 'b1', 'c1', 'a2', 'b2'], 5).ids).toEqual(['a1', 'b2', 'c3', 'b1', 'c1']);
  });

  test('a tie on share goes to the earlier candidate in fused order', () => {
    const pool = [
      hit('x', 'A'), hit('first', 'B', { kinds: ['keyword_first'], conceptShare: 0.75 }),
      hit('y', 'A'), hit('second', 'C', { kinds: ['keyword_first'], conceptShare: 0.75 }),
    ];
    expect(seat(pool, ['x', 'y', 'first'], 3).ids.slice(0, 2)).toEqual(['x', 'first']);
  });

  test('a leader under half the question\'s concepts gets no seat (negative-1 keeps its order)', () => {
    expect(RESERVED_LEADER_MIN_CONCEPT_SHARE).toBe(0.5);
    const pool = [
      hit('a1', 'A'), hit('b1', 'B'), hit('c1', 'C'),
      hit('weak', 'C', { kinds: ['keyword_first', 'name'], conceptShare: 0.25 }),
    ];
    const budgeted = ['a1', 'b1', 'c1'];
    expect(seat(pool, budgeted, 3)).toEqual({ ids: budgeted, degradations: [] });
  });

  test('a leader already at or above its seat stays; one seated lower moves up', () => {
    const pool = [
      hit('lead', 'A', { kinds: ['keyword_first'], conceptShare: 1 }), hit('b1', 'B'), hit('c1', 'C'),
      hit('name', 'B', { kinds: ['name'], conceptShare: 1 }),
    ];
    expect(seat(pool, ['lead', 'b1', 'c1', 'name'], 4).ids).toEqual(['lead', 'b1', 'name', 'c1']);
  });

  test('fewer than three seats: nothing is reserved', () => {
    const pool = [hit('a1', 'A'), hit('b1', 'B'), hit('lead', 'B', { kinds: ['keyword_first'], conceptShare: 1 })];
    expect(seat(pool, ['a1', 'b1'], 2).ids).toEqual(['a1', 'b1']);
  });

  test('a store that loses its only seat is reported as cut', () => {
    const pool = [
      hit('a1', 'A'), hit('b1', 'B'), hit('c1', 'C'),
      hit('a2', 'A', { kinds: ['keyword_first'], conceptShare: 1 }),
    ];
    const result = seat(pool, ['a1', 'b1', 'c1'], 3);
    expect(result.ids).toEqual(['a1', 'a2', 'b1']);
    expect(result.degradations).toEqual([{ laneName: 'C', laneType: 'keyword', reason: 'lane_budget_cut', occurrences: 1 }]);
  });

  test('a store a leader brings back is no longer reported as cut', () => {
    const pool = [
      hit('a1', 'A'), hit('b1', 'B'), hit('c1', 'C'),
      hit('d1', 'D', { kinds: ['keyword_first'], conceptShare: 1 }),
    ];
    const cut = (laneName: string) => ({ laneName, laneType: 'keyword' as const, reason: 'lane_budget_cut' as const, occurrences: 1 });
    const result = withReservedLeaderSeats({ hits: [pool[0]!, pool[1]!, pool[2]!], degradations: [cut('D')] }, pool, 3);
    expect(result.hits.map((h) => h.id)).toEqual(['a1', 'd1', 'b1']);
    expect(result.degradations).toEqual([cut('C')]);
  });
});

describe('name leader seat', () => {
  // P = readable partial match, W = readable whole-question match, N = the names-only leader.
  const seat = (order: string[]) => {
    const entries = [...order];
    seatNameLeader(entries, {
      isLeader: (entry) => entry === 'N',
      matchesWholeQuestion: (entry) => entry.startsWith('W'),
      readable: (entry) => entry !== 'N',
    });
    return entries;
  };

  test('right after the best readable partial match', () => {
    expect(seat(['W1', 'P1', 'P2', 'N'])).toEqual(['W1', 'P1', 'N', 'P2']);
  });

  test('never ahead of a whole-question match the final order placed after a partial one', () => {
    expect(seat(['P1', 'W1', 'N'])).toEqual(['P1', 'W1', 'N']);
    expect(seat(['P1', 'W1', 'P2', 'N'])).toEqual(['P1', 'W1', 'N', 'P2']);
  });

  test('never past the latest seat it is given, and never the first seat', () => {
    const clamp = (order: string[], latestSeat: number) => {
      const entries = [...order];
      seatNameLeader(entries, {
        isLeader: (entry) => entry === 'N',
        matchesWholeQuestion: (entry) => entry.startsWith('W'),
        readable: (entry) => entry !== 'N',
        latestSeat,
      });
      return entries;
    };
    expect(clamp(['P1', 'W1', 'W2', 'W3', 'N'], 2)).toEqual(['P1', 'W1', 'N', 'W2', 'W3']);
    expect(clamp(['P1', 'W1', 'W2', 'N'], 0)).toEqual(['P1', 'N', 'W1', 'W2']);
    // Within the latest seat, the seat rule's own place stands.
    expect(clamp(['W1', 'P1', 'P2', 'N'], 3)).toEqual(['W1', 'P1', 'N', 'P2']);
  });

  test('a leader already seated higher stays put', () => {
    expect(seat(['P1', 'N', 'P2'])).toEqual(['P1', 'N', 'P2']);
  });
});

async function withStore(
  run: (store: LocalConnectorStore, provider: SourceEmbeddingProvider) => Promise<void>,
  items: readonly FixtureItem[] = [TARGET, ...NEIGHBOURS],
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-keyword-leader-'));
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'leader.sqlite'),
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'internal',
  });
  const provider = embeddingProvider();
  try {
    await store.syncFromConnector(fixtureConnector(items), { fetchContent: true });
    await store.embedChunks({ provider });
    await run(store, provider);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixtureConnector(items: readonly FixtureItem[]): SourceConnector {
  const rawItems = items.map((item): RawItem => ({
    identity: {
      family: 'file',
      provider: 'fake_leader',
      accountScope: ACCOUNT,
      providerItemId: item.id,
      providerFileId: item.id,
      localItemId: `${ACCOUNT}:${item.id}`,
      sourceVersion: `${item.id}:v1`,
    },
    mimeType: 'text/plain',
    content: item.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: item.text },
    metadata: Object.freeze({
      name: item.name,
      locatorUri: `/notes/${item.name}`,
      pathDisplay: `/notes/${item.name}`,
      updatedAt: '2026-11-10T10:00:00.000Z',
    }),
    fetchedAt: '2026-11-10T10:00:00.000Z',
  }));
  const byId = new Map(rawItems.map((item) => [item.identity.localItemId, item]));
  return {
    id: 'fake-leader',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: rawItems, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = byId.get(localItemId);
      if (!item) throw new Error(`missing fixture ${localItemId}`);
      return item;
    },
    classificationSignals() {
      return {};
    },
  };
}

// Two axes: [the notes' topic, the target's topic]. A query naming "vessel
// cover" sits on the target's axis; any other query sits on the notes' axis.
// Notes lean slightly off-axis by index so the vector lane has a stable order.
function embeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'keyword-leader-fixture',
    modelId: 'keyword-leader-v1',
    dimension: 2,
    configHash: 'keyword-leader-config',
    epochId: 'local:keyword-leader-fixture:keyword-leader-v1:2',
    backend: 'local',
    async embed(inputs: SourceEmbeddingInput[], options): Promise<number[][]> {
      return inputs.map((input) => {
        const text = `${input.title ?? ''}\n${input.text}`.toLowerCase();
        if (options.taskType === 'RETRIEVAL_QUERY') return text.includes('vessel cover') ? [0, 1] : [1, 0];
        if (text.includes('zx-4471')) return [0, 1];
        const match = /marina log (\d+)/.exec(text);
        const lean = match ? Number(match[1]) / 200 : 0;
        return [1, lean];
      });
    },
  };
}

async function search(
  store: LocalConnectorStore,
  query: string,
  options: { retrievalMode: 'keyword' | 'hybrid'; maxResults: number; provider?: SourceEmbeddingProvider; semanticRelevanceBar?: number },
) {
  const adapter = createConnectorStoreCorpusAdapter({
    store,
    retrievalMode: options.retrievalMode,
    ...(options.provider ? { embeddingProvider: options.provider } : {}),
    ...(options.semanticRelevanceBar !== undefined ? { semanticRelevanceBar: options.semanticRelevanceBar } : {}),
  });
  return adapter({
    query,
    maxResults: options.maxResults,
    corpus: defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }),
    context: { allowedTrustDomains: [store.trustDomain] },
  });
}

function hitIds(response: { hits: ReadonlyArray<{ sourceItem: { providerItemId: string } }> }): string[] {
  return response.hits.map((hit) => hit.sourceItem.providerItemId);
}
