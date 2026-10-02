// The retrieval relevance floor, and ranking within it.
//
// 2026-10-02 live smoke over ChatGPT: every question reported a Private match
// (12 items), so every reply got the private panel and the panel answered
// "these private items do not answer this question"; and a Personal search
// for "What do I have about integral theory?" returned seven diet and
// Ayurveda PDFs (full passages) above every file named for the topic. Three
// generic causes, pinned here on synthetic fixtures:
//
// 1. Request scaffolding ("what do I have about", "files", "show") was
//    searched as topic words, so every readable document matched every
//    question on "do", "have" and "about".
// 2. The built-in embedding model had no calibrated relevance bar, so its
//    nearest neighbours (everything with text) counted as matches.
// 3. Within a corpus, any readable match outranked any name match, however
//    little of the question it matched.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { sourceIndexFtsTerms } from '../src/core/source-index/fts.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { BUILT_IN_EMBEDDING_MODEL } from '../src/workers/source-index/built-in-embedding/manifest.ts';
import { searchPrivateEvidence, type AnalystAnswerLanes } from '../src/workers/source-index/analyst-answer.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';

interface FixtureItem {
  id: string;
  name: string;
  text?: string;
}

// Readable guides that say the scaffolding words, and common words, but are
// about something else.
const GUIDES: FixtureItem[] = Array.from({ length: 7 }, (_, index) => ({
  id: `guide-${index}`,
  name: `diet-guide-${index}.pdf`,
  text: `What do I have to know about this plan? Do what works for you, and have 3 meals at a steady level. `
    + `Rest well; blood sugar and work stress matter. Study the list ${index}.`,
}));

const NAMES: FixtureItem[] = [
  { id: 'name-theory', name: 'A theory of everything an integral vision.djvu' },
  { id: 'name-psych', name: 'Ken Wilber Integral Psychology.epub' },
  { id: 'name-syc', name: 'Sycophancy in GPT-4o What Happened.md' },
];

// Many items say "AI"; one name is the only one that says "sycophancy".
const AI_NOTES: FixtureItem[] = Array.from({ length: 12 }, (_, index) => ({
  id: `ai-${index}`,
  name: `ai-note-${index}.md`,
  text: `Notes on AI tools, number ${index}.`,
}));

const PARTIAL_PSYCH: FixtureItem = {
  id: 'partial-psych',
  name: 'seminar-reader.pdf',
  text: 'Ken Wilber frames an integral view of development in this reader.',
};

const OMEGA: FixtureItem = { id: 'omega', name: '2025-01-27 Omega 3 index test.pdf', text: 'Omega-3 index 6.1 percent.' };

describe('query terms', () => {
  test('request scaffolding and item-kind words are not searched; topic words are', () => {
    expect(sourceIndexFtsTerms('What do I have about integral theory?')).toEqual(['integral', 'theory']);
    expect(sourceIndexFtsTerms('What ayurveda files do I have?')).toEqual(['ayurveda']);
    expect(sourceIndexFtsTerms('What did I save about AI sycophancy?')).toEqual(['ai', 'sycophancy']);
    expect(sourceIndexFtsTerms('Show me the papers on theories of consciousness')).toEqual(['theories', 'consciousness']);
    // Words that are also subjects stay searchable.
    expect(sourceIndexFtsTerms('What does my will say about the house in May?')).toEqual(['will', 'house', 'may']);
  });
});

describe('keyword lane: the floor and the order within it', () => {
  test('a topic question returns the files named for it, not every readable file', async () => {
    await withStore([...GUIDES, ...NAMES, ...AI_NOTES], async (store) => {
      for (const retrievalMode of ['keyword', 'hybrid'] as const) {
        const ids = hitIds(await search(store, 'What do I have about integral theory?', { retrievalMode, maxResults: 8 }));
        expect({ retrievalMode, ids }).toEqual({ retrievalMode, ids: ['name-theory'] });
      }
    });
  });

  test('a name matching the whole question outranks a readable item matching part of it', async () => {
    await withStore([...GUIDES, ...NAMES, PARTIAL_PSYCH], async (store) => {
      // Four concepts: the name has all four, the reader three (Ken, Wilber,
      // integral). Both clear the floor; the whole match leads.
      const ids = hitIds(await search(store, 'Ken Wilber integral psychology', { retrievalMode: 'keyword', maxResults: 5 }));
      expect(ids.slice(0, 2)).toEqual(['name-psych', 'partial-psych']);
    });
  });

  test('a rare word carries a question on its own; two common words of it do not', async () => {
    await withStore([...GUIDES, ...NAMES, ...AI_NOTES, OMEGA], async (store) => {
      // "sycophancy" is in one item, "AI" in many: the rare word's file is found.
      const syc = hitIds(await search(store, 'What did I save about AI sycophancy?', { retrievalMode: 'keyword', maxResults: 5 }));
      expect(syc).toEqual(['name-syc']);
      // "3" and "level" are in every guide; only the item that also says "omega" matches.
      const omega = hitIds(await search(store, 'What is my omega-3 level?', { retrievalMode: 'keyword', maxResults: 5 }));
      expect(omega).toEqual(['omega']);
    });
  });

  test('two common words of a four-concept question are not a match', async () => {
    await withStore([...GUIDES, OMEGA], async (store) => {
      // The guides say "blood" and "work", never "June" or "2026".
      const ids = hitIds(await search(store, 'What did my June 2026 blood work show?', { retrievalMode: 'keyword', maxResults: 5 }));
      expect(ids).toEqual([]);
    });
  });
});

describe('vector lane: the built-in model\'s calibrated bar', () => {
  test('a neighbour below 0.40 is no evidence and no match; one at or above it is', async () => {
    await withStore(GUIDES, async (store) => {
      const provider = builtInLikeProvider();
      await store.embedChunks({ provider });
      // No keyword match ("zzq" is nowhere): only the vector lane can match.
      const below = await search(store, 'zzq below', { retrievalMode: 'hybrid', maxResults: 5, provider });
      expect(hitIds(below)).toEqual([]);
      expect(below.matchCount?.matchedItems ?? 0).toBe(0);
      const above = await search(store, 'zzq above', { retrievalMode: 'hybrid', maxResults: 5, provider });
      expect(hitIds(above)).toEqual(GUIDES.map((guide) => guide.id).slice(0, 5));
      expect(above.matchCount?.matchedItems).toBe(GUIDES.length);
    });
  });
});

describe('the private match floor', () => {
  test('an off-topic question matches no Private item; an on-topic one does', async () => {
    const report: FixtureItem = {
      id: 'report',
      name: '2026-06-29 blood work 1.pdf',
      text: 'Collected June 2026. Ferritin 84 ng/mL. I do have to repeat this about every year.',
    };
    await withStore([report], async (store) => {
      const provider = builtInLikeProvider();
      await store.embedChunks({ provider });
      const lanes = privateLanes(store, provider);
      for (const question of ['What do I have about integral theory?', 'What ayurveda files do I have?', 'What do I have about Whole30?']) {
        const found = await searchPrivateEvidence({ lanes, question });
        expect({ question, matched: found.matched }).toEqual({ question, matched: 0 });
      }
      const blood = await searchPrivateEvidence({ lanes, question: 'What did my June 2026 blood work show?' });
      expect(blood.matched).toBe(1);
      // A paraphrase with no shared word matches through the vector lane, above the bar.
      const paraphrase = await searchPrivateEvidence({ lanes, question: 'zzq above' });
      expect(paraphrase.matched).toBe(1);
    }, 'secure_local');
  });
});

// A stand-in with the built-in model's identity (so its calibrated bar
// applies). Every document sits on one axis; a query lands at a set cosine
// to it: "below" at 0.39, "above" at 0.41, anything else at 0.30.
function builtInLikeProvider(): SourceEmbeddingProvider {
  const at = (cosine: number) => [cosine, Math.sqrt(1 - cosine * cosine)];
  return {
    provider: 'built-in',
    modelId: BUILT_IN_EMBEDDING_MODEL.modelId,
    dimension: 2,
    configHash: 'relevance-floor-fixture',
    epochId: `local:built-in:${BUILT_IN_EMBEDDING_MODEL.modelId}:2`,
    backend: 'local',
    async embed(inputs: SourceEmbeddingInput[], options): Promise<number[][]> {
      return inputs.map((input) => {
        if (options.taskType !== 'RETRIEVAL_QUERY') return [1, 0];
        if (input.text.includes('below')) return at(0.39);
        if (input.text.includes('above')) return at(0.41);
        return at(0.3);
      });
    },
  };
}

type Store = LocalConnectorStore;

async function withStore(
  items: readonly FixtureItem[],
  run: (store: Store) => Promise<void>,
  trustDomain: 'internal' | 'secure_local' = 'internal',
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-relevance-floor-'));
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'files.sqlite'),
    corpusId: `${trustDomain}.fixture.files`,
    family: 'file',
    trustDomain,
  });
  try {
    await store.syncFromConnector(fixtureConnector(items), { fetchContent: true });
    await run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function privateLanes(store: Store, provider: SourceEmbeddingProvider): () => AnalystAnswerLanes {
  return () => ({
    registry: buildSourceIndexCorpusRegistry([
      defineConnectorCorpus({ corpusId: store.corpusId, family: 'file', trustDomain: 'secure_local' }),
    ]),
    adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store, embeddingProvider: provider, retrievalMode: 'hybrid' }) },
    contentProviders: { [store.corpusId]: createConnectorStoreContentProvider({ store }) },
  }) as unknown as AnalystAnswerLanes;
}

function fixtureConnector(items: readonly FixtureItem[]): SourceConnector {
  const rawItems = items.map((item): RawItem => ({
    identity: {
      family: 'file',
      provider: 'fixture',
      accountScope: ACCOUNT,
      providerItemId: item.id,
      providerFileId: item.id,
      localItemId: `${ACCOUNT}:${item.id}`,
      sourceVersion: `${item.id}:v1`,
    },
    mimeType: item.text === undefined ? 'application/octet-stream' : 'application/pdf',
    content: item.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: item.text },
    metadata: Object.freeze({
      name: item.name,
      locatorUri: `/files/${item.name}`,
      pathDisplay: `/files/${item.name}`,
      updatedAt: '2026-10-02T10:00:00.000Z',
    }),
    fetchedAt: '2026-10-02T10:00:00.000Z',
  }));
  const byId = new Map(rawItems.map((item) => [item.identity.localItemId, item]));
  return {
    id: 'relevance-floor-fixture',
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

async function search(
  store: Store,
  query: string,
  options: { retrievalMode: 'keyword' | 'hybrid'; maxResults: number; provider?: SourceEmbeddingProvider },
) {
  const adapter = createConnectorStoreCorpusAdapter({
    store,
    retrievalMode: options.retrievalMode,
    ...(options.provider ? { embeddingProvider: options.provider } : {}),
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
