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
import { withLaneLeadersSeated } from '../src/workers/connector-store/local-index.ts';
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
