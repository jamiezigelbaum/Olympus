import { describe, expect, test } from 'bun:test';
import { buildEvidencePackDetailed, type LocalContentProvider } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { RESERVED_RECENCY_SEATS, withReservedRecencySeats } from '../src/core/source-index/retrieval.ts';
import type { SourceIndexCorpusSearchAdapter, SourceIndexSearchContext } from '../src/core/source-index/router.ts';
import { buildSourceSensitivity, type SourceFamily } from '../src/core/source-index/types.ts';
import { DEFAULT_LOCAL_ANALYST_PROMPT_BYTES, fitPackToPromptBytes } from '../src/workers/source-index/analyst-answer.ts';

// The 2026-07-05 "did I just get..." case. A chat store pins its newest
// messages at the tail of its cut (withPinnedNewestChatHits), behind its
// relevance hits. For a question with temporal intent they take seats 4 and 5,
// after seat 1 and the reserved leader seats, at any pack size and with any
// number of stores; for any other question nothing moves.

const allowAll: SourceIndexSearchContext = { allowedTrustDomains: ['internal', 'secure_local', 'public_safe'] };
const CHAT = 'internal.chat.messages';

interface FixtureHit { id: string; at: string; newestInStore?: number }

function storeAdapter(family: SourceFamily, hits: readonly FixtureHit[]): SourceIndexCorpusSearchAdapter {
  return () => ({
    hits: hits.map((hit, index) => {
      const sourceItem = { family, provider: 'fixture', accountScope: 'personal', providerItemId: hit.id, localItemId: hit.id };
      return {
        sourceItem,
        provenance: { sourceItem, citation: { title: hit.id, authoredAt: hit.at } },
        score: 1 - index * 0.01,
        ...(hit.newestInStore ? { newestInStore: hit.newestInStore } : {}),
        rawExposed: false as const,
      };
    }),
    latencyMs: 1,
    laneAudits: [],
    rawExposed: false as const,
  });
}

const textProvider: LocalContentProvider = {
  async fetchLocalContent(request) {
    return {
      sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
      chunks: [`${request.provenance.sourceItem.providerItemId} from the clinic ${'x'.repeat(2_500)}`],
    };
  },
};

const older = (prefix: string, count: number): FixtureHit[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, at: `2026-0${1 + (index % 8)}-10T09:00:00.000Z` }));

// What withPinnedNewestChatHits returns at this cut: relevance hits, then the
// two newest messages.
const chatHits = (seats: number): FixtureHit[] => [
  ...older('chat-old', seats - 2),
  { id: 'chat-newest', at: '2026-11-11T08:40:00.000Z', newestInStore: 1 },
  { id: 'chat-second', at: '2026-11-11T08:00:00.000Z', newestInStore: 2 },
];

async function seats(question: string, seatCount: number, storeCount: number) {
  const stores: Array<{ id: string; family: SourceFamily; hits: FixtureHit[] }> = [
    ...Array.from({ length: storeCount - 1 }, (_, index) => (
      { id: `internal.store-${index}.items`, family: 'file' as const, hits: older(`store-${index}`, seatCount) })),
    { id: CHAT, family: 'chat', hits: chatHits(seatCount) },
  ];
  const detail = await buildEvidencePackDetailed({
    question,
    maxResults: seatCount,
    searchContext: allowAll,
    registry: buildSourceIndexCorpusRegistry(stores.map((store) => defineSourceIndexCorpus({ corpusId: store.id, family: store.family, trustDomain: 'internal' }))),
    adapters: Object.fromEntries(stores.map((store) => [store.id, storeAdapter(store.family, store.hits)])),
    contentProviders: Object.fromEntries(stores.map((store) => [store.id, textProvider])),
  });
  const corpusOf = new Map(detail.pack.candidates.map((candidate, index) => [candidate, detail.candidateCorpusIds[index] ?? ''] as const));
  const read = fitPackToPromptBytes(detail.pack, DEFAULT_LOCAL_ANALYST_PROMPT_BYTES, corpusOf, { localOnly: true }, detail.recencySeats);
  const ids = (candidates: typeof detail.pack.candidates) => candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId);
  return { pack: ids(detail.pack.candidates), read: ids(read.candidates) };
}

describe('recency seats', () => {
  for (const seatCount of [5, 8, 24]) {
    for (const storeCount of [1, 3] as const) {
      test(`a recency question reads the newest chat messages at seats 4 and 5 (${seatCount} seats, ${storeCount} store${storeCount === 1 ? '' : 's'})`, async () => {
        const { pack, read } = await seats('Did I just get a message from the clinic?', seatCount, storeCount);
        expect(pack).toHaveLength(seatCount);
        expect(pack.slice(3, 5)).toEqual(['chat-newest', 'chat-second']);
        expect(read).toContain('chat-newest');
        expect(read).toContain('chat-second');
      });
    }
  }

  test('with many stores, the local fit still reads the recency seats (22 stores, 24 seats)', async () => {
    const { pack, read } = await seats('Did I just get a message from the clinic?', 24, 22);
    expect(pack.slice(3, 5)).toEqual(['chat-newest', 'chat-second']);
    expect(read.length).toBeLessThan(pack.length);
    expect(read.slice(3, 5)).toEqual(['chat-newest', 'chat-second']);
  });

  test('any other question keeps relevance order and leaves the pinned messages where the store put them', async () => {
    const recency = await seats('Did I just get a message from the clinic?', 24, 1);
    const plain = await seats('What did the clinic say?', 24, 1);
    expect(plain.pack.slice(22)).toEqual(['chat-newest', 'chat-second']);
    expect(plain.pack.slice(0, 3)).toEqual(recency.pack.slice(0, 3));
  });
});

describe('withReservedRecencySeats', () => {
  type Hit = { corpusId: string; id: string; newestInStore?: number; provenance?: { citation?: { authoredAt?: string } } };
  const hit = (corpusId: string, id: string, at?: string, newestInStore?: number): Hit => ({
    corpusId, id, ...(newestInStore ? { newestInStore } : {}), ...(at ? { provenance: { citation: { authoredAt: at } } } : {}),
  });

  test('takes the newest pinned messages across chat stores, newest first, after the first three seats', () => {
    const pool = [
      hit('mail', 'm1'), hit('chat-a', 'a1'), hit('chat-b', 'b1'), hit('mail', 'm2'), hit('chat-a', 'a2'), hit('mail', 'm3'),
      hit('chat-a', 'a-new', '2026-11-11T08:00:00.000Z', 1), hit('chat-b', 'b-new', '2026-11-11T08:30:00.000Z', 1),
      hit('chat-b', 'b-second', '2026-11-11T07:00:00.000Z', 2),
    ];
    const budgeted = { hits: pool.slice(0, 6), degradations: [] };
    const { hits } = withReservedRecencySeats(budgeted, pool, 6);
    expect(hits.map((h) => h.id)).toEqual(['m1', 'a1', 'b1', 'b-new', 'a-new', 'm2']);
    expect(RESERVED_RECENCY_SEATS).toBe(2);
  });

  test('a pinned message already seated above its reserved seat keeps its place', () => {
    const pool = [hit('chat', 'new', '2026-11-11T08:00:00.000Z', 1), hit('mail', 'm1'), hit('mail', 'm2'), hit('mail', 'm3'), hit('mail', 'm4')];
    const budgeted = { hits: pool.slice(), degradations: [] };
    expect(withReservedRecencySeats(budgeted, pool, 5).hits).toBe(budgeted.hits);
  });

  test('a pack of three seats or fewer has no recency seat', () => {
    const pool = [hit('mail', 'm1'), hit('mail', 'm2'), hit('mail', 'm3'), hit('chat', 'new', '2026-11-11T08:00:00.000Z', 1)];
    const budgeted = { hits: pool.slice(0, 3), degradations: [] };
    expect(withReservedRecencySeats(budgeted, pool, 3)).toMatchObject({ hits: budgeted.hits, recencySeats: 0 });
  });

  test('a store brought back by a recency seat is no longer reported as cut', () => {
    const pool = [hit('mail', 'm1'), hit('mail', 'm2'), hit('mail', 'm3'), hit('mail', 'm4'), hit('chat', 'new', '2026-11-11T08:00:00.000Z', 1)];
    const budgeted = {
      hits: pool.slice(0, 4),
      degradations: [{ laneName: 'chat', laneType: 'keyword' as const, reason: 'lane_budget_cut' as const, occurrences: 1 }],
    };
    const result = withReservedRecencySeats(budgeted, pool, 4);
    expect(result.hits.map((h) => h.id)).toEqual(['m1', 'm2', 'm3', 'new']);
    expect(result.degradations).toEqual([]);
  });
});

describe('recency seats never cost a store its seat in the pack', () => {
  type Hit = { corpusId: string; id: string; newestInStore?: number; provenance?: { citation?: { authoredAt?: string } } };
  const hit = (corpusId: string, id: string, at?: string, newestInStore?: number): Hit => ({
    corpusId, id, ...(newestInStore ? { newestInStore } : {}), ...(at ? { provenance: { citation: { authoredAt: at } } } : {}),
  });

  test('with more stores than seats, a cut pinned message takes no seat', () => {
    const stores = ['s1', 's2', 's3', 's4', 's5'];
    const pool = [...stores.map((store) => hit(store, `${store}-first`)), hit('chat', 'new', '2026-11-11T08:00:00.000Z', 1)];
    const budgeted = { hits: pool.slice(0, 5), degradations: [] };
    expect(withReservedRecencySeats(budgeted, pool, 5)).toMatchObject({ hits: budgeted.hits, recencySeats: 0 });
  });

  test('it drops a store\'s later result, never its only one', () => {
    const pool = [hit('a', 'a1'), hit('b', 'b1'), hit('c', 'c1'), hit('a', 'a2'), hit('d', 'd1'), hit('chat', 'new', '2026-11-11T08:00:00.000Z', 1)];
    const budgeted = { hits: pool.slice(0, 5), degradations: [] };
    const result = withReservedRecencySeats(budgeted, pool, 5);
    expect(result.hits.map((h) => h.id)).toEqual(['a1', 'b1', 'c1', 'new', 'd1']);
    expect(result.recencySeats).toBe(1);
  });

  test('a local fit reads the recency seats right after the first three, then stores in turn', () => {
    const candidate = (id: string) => ({
      provenance: { sourceItem: { family: 'file' as const, provider: 'fixture', accountScope: 'personal', providerItemId: id, localItemId: id } },
      trustTier: 'S2' as const,
      trustDomain: 'internal' as const,
      chunks: ['x'.repeat(2_000)],
    });
    // Seats 1-3, two recency seats, then eight stores' first results.
    const ordered: Array<[ReturnType<typeof candidate>, string]> = [
      [candidate('lead-0'), 'store-0'], [candidate('lead-1'), 'store-0'], [candidate('lead-2'), 'store-0'],
      [candidate('newest'), 'chat'], [candidate('second'), 'chat'],
      ...Array.from({ length: 8 }, (_, index) => [candidate(`store-${index + 1}-first`), `store-${index + 1}`] as [ReturnType<typeof candidate>, string]),
    ];
    const pack = {
      question: 'q',
      candidates: ordered.map(([c]) => c),
      coverage: { searchedCorpora: [...new Set(ordered.map(([, corpus]) => corpus))], skippedCorpora: [], extractionGaps: [] },
      builtAt: '2026-11-11T00:00:00Z',
    };
    const corpusOf = new Map(ordered);
    const read = fitPackToPromptBytes(pack as never, 13_500, corpusOf as never, { localOnly: true }, 2)
      .candidates.map((c) => c.provenance.sourceItem.providerItemId);
    // Eight seats fit: the first three, the recency seats (asked for), then
    // stores in turn.
    expect(read.length).toBeLessThan(ordered.length);
    expect(read.slice(0, 5)).toEqual(['lead-0', 'lead-1', 'lead-2', 'newest', 'second']);
    expect(read.slice(5)).toEqual(read.slice(5).map((_, index) => `store-${index + 1}-first`));
  });
});
