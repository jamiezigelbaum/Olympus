// Names only is the owner's choice, not a failed read.
//
// A folder set to Names only in the folder picker keeps its items' names
// searchable and their contents unread on purpose. Search coverage used to
// lump those matches with items Olympus genuinely could not read, so ChatGPT
// told the owner "Olympus could not read 24 matching items" about a folder they
// had deliberately left unread. These tests pin the split, source-agnostically:
// the content provider marks the item `namesOnly` from the scope it was given,
// the evidence pack counts it apart, and the ChatGPT search result says so in
// its own sentence while a genuine failed read still says "could not read".

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
  type ConnectorStoreSearchFilters,
} from '../src/workers/connector-store/index.ts';
import { CONNECTOR_STORE_NAMES_ONLY_SCOPE_GAP } from '../src/workers/connector-store/local-index.ts';
import { releaseAnalystAnswer, searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';

const CORPUS_ID = 'internal.fake.files';
const PROVIDER = 'fake_files';
const ACCOUNT = 'personal';

interface ItemSpec { id: string; path: string; mimeType: string; text?: string }

// The book HAS stored text: proof the provider withholds it, not merely that
// there was none to return.
const BOOK: ItemSpec = { id: 'book-1', path: '/books/orchard handbook.pdf', mimeType: 'application/pdf', text: 'Orchard pruning chapter one.' };
const BOOK_2: ItemSpec = { id: 'book-2', path: '/books/orchard atlas.pdf', mimeType: 'application/pdf' };
const NOTE: ItemSpec = { id: 'note-1', path: '/notes/orchard plan.md', mimeType: 'text/markdown', text: 'Orchard plan: prune in winter.' };
const SCAN: ItemSpec = { id: 'scan-1', path: '/notes/orchard scan.pdf', mimeType: 'application/pdf' };

// What the folder picker produces for "/notes = Full, /books = Names only".
const METADATA_FILTERS: ConnectorStoreSearchFilters = { locatorPathScopes: ['/notes', '/books'] };
const CONTENT_FILTERS: ConnectorStoreSearchFilters = {
  locatorPathScopes: ['/notes'],
  locatorPathExcludedScopes: ['/books'],
};

describe('Names-only matches are counted apart from unreadable ones', () => {
  test('the provider returns a Names-only item without its text and marks it', async () => {
    const store = await storeWith([BOOK, NOTE, SCAN]);
    const provider = createConnectorStoreContentProvider({
      store, filters: CONTENT_FILTERS, metadataFilters: METADATA_FILTERS,
    });
    const book = await fetch(provider, BOOK);
    expect(book).toMatchObject({ chunks: [], namesOnly: true, coverageGaps: [CONNECTOR_STORE_NAMES_ONLY_SCOPE_GAP] });
    expect(JSON.stringify(book)).not.toContain('pruning chapter');
    const scan = await fetch(provider, SCAN);
    expect(scan?.namesOnly).toBeUndefined();
    expect(scan?.chunks).toEqual([]);
    expect((await fetch(provider, NOTE))?.chunks.join(' ')).toContain('prune in winter');

    // No content scope at all: every searchable item is Names only.
    const namesOnlyProvider = createConnectorStoreContentProvider({
      store, metadataFilters: METADATA_FILTERS, contentAllowed: false,
    });
    expect((await fetch(namesOnlyProvider, NOTE))).toMatchObject({ chunks: [], namesOnly: true });

    // Without a names scope nothing is claimed as Names only.
    expect(await fetch(createConnectorStoreContentProvider({ store, filters: CONTENT_FILTERS }), BOOK)).toBeUndefined();
    store.close();
  });

  test('the evidence pack detail counts Names-only and unreadable candidates separately', async () => {
    const store = await storeWith([BOOK, BOOK_2, NOTE, SCAN]);
    const detail = await buildEvidencePackDetailed({
      question: 'orchard',
      maxResults: 10,
      searchContext: { allowedTrustDomains: ['internal'] },
      registry: registry(),
      adapters: {},
      contentProviders: {
        [CORPUS_ID]: createConnectorStoreContentProvider({
          store, filters: CONTENT_FILTERS, metadataFilters: METADATA_FILTERS,
        }),
      },
      selectedItems: [BOOK, BOOK_2, NOTE, SCAN].map((spec) => ({
        corpusId: CORPUS_ID,
        sourceItem: identity(spec),
        citation: { title: spec.path.split('/').pop()! },
      })),
    });
    expect(detail.pack.candidates).toHaveLength(4);
    expect(detail.namesOnlyCandidateIndexes).toEqual([0, 1]);
    expect(detail.unreadCandidates).toBe(1);

    // The answer path says the same split: the scan could not be read, the
    // two books are in a Names-only folder.
    const noteCandidate = detail.pack.candidates[2]!;
    const released = releaseAnalystAnswer({
      detail,
      result: {
        answer: 'The plan is to prune in winter.',
        citations: [{ provenance: noteCandidate.provenance, claim: 'Orchard plan: prune in winter.' }],
        unanswered: [],
      },
      releaseSecureContent: false,
    });
    expect(released.answer).toContain('1 matched file found, but it could not be read or extracted in this pass.');
    expect(released.answer).toContain('2 matches are in folders set to Names only');
    expect(released.answer).not.toContain('3 matched files');
    store.close();
  });

  test('olympus_search says Names only in its own sentence and keeps "could not read" for real failures', async () => {
    const store = await storeWith([BOOK, BOOK_2, NOTE, SCAN]);
    const raw = await searchReleasedEvidence({
      question: 'orchard',
      maxResults: 10,
      lanes: () => ({
        registry: registry(),
        adapters: { [CORPUS_ID]: createConnectorStoreCorpusAdapter({ store, filters: METADATA_FILTERS }) },
        contentProviders: {
          [CORPUS_ID]: createConnectorStoreContentProvider({
            store, filters: CONTENT_FILTERS, metadataFilters: METADATA_FILTERS,
          }),
        },
      }),
    });
    expect(raw.coverage.names_only_items).toBe(2);
    expect(raw.coverage.unreadable_items).toBe(1);

    const result = searchToolResult(raw);
    const structured = result.structuredContent as { coverage: Record<string, number>; notes: string[] };
    expect(structured.coverage).toMatchObject({ namesOnlyItems: 2, unreadableItems: 1 });
    expect(structured.notes).toContain(
      '2 matches are in folders set to Names only, so Olympus has their names but not their contents. '
      + 'Switch those folders to Full in the folder picker to let Olympus read them.',
    );
    expect(structured.notes).toContain('Olympus could not read 1 matching item.');
    // Counts only: no folder name reaches ChatGPT through the coverage notes.
    expect(structured.notes.join(' ')).not.toContain('books');
    store.close();
  });

  test('one Names-only match reads in the singular; none adds no sentence', () => {
    const one = searchToolResult({ evidence: [], coverage: { searched_corpora: 1, names_only_items: 1 } });
    expect((one.structuredContent as { notes: string[] }).notes).toEqual([
      '1 match is in a folder set to Names only, so Olympus has its name but not its contents. '
      + 'Switch that folder to Full in the folder picker to let Olympus read it.',
    ]);
    const none = searchToolResult({ evidence: [], coverage: { searched_corpora: 1, names_only_items: 0 } });
    expect((none.structuredContent as { notes: string[] }).notes).toEqual([]);
  });
});

function registry() {
  return buildSourceIndexCorpusRegistry([
    defineConnectorCorpus({ corpusId: CORPUS_ID, family: 'file', trustDomain: 'internal' }),
  ]);
}

function identity(spec: ItemSpec) {
  return {
    family: 'file' as const,
    provider: PROVIDER,
    accountScope: ACCOUNT,
    providerItemId: spec.id,
    localItemId: `${ACCOUNT}:${spec.id}`,
  };
}

async function fetch(provider: ReturnType<typeof createConnectorStoreContentProvider>, spec: ItemSpec) {
  return provider.fetchLocalContent({ provenance: { sourceItem: identity(spec) }, trustDomain: 'internal' });
}

async function storeWith(specs: readonly ItemSpec[]): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'names-only-coverage-')), 'store.sqlite'),
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'internal',
  });
  await store.syncFromConnector(fakeConnector(specs), { fetchContent: true });
  return store;
}

function rawItem(spec: ItemSpec): RawItem {
  return {
    identity: { ...identity(spec), providerFileId: spec.id },
    mimeType: spec.mimeType,
    content: spec.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: spec.text },
    metadata: { name: spec.path.split('/').pop()!, locatorUri: spec.path },
    fetchedAt: '2026-10-01T12:00:00.000Z',
  };
}

function fakeConnector(specs: readonly ItemSpec[]): SourceConnector {
  return {
    id: 'fake_files_connector',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: specs.map(rawItem), done: true };
      })();
    },
    async fetchItem(id: string): Promise<RawItem> {
      const spec = specs.find((candidate) => `${ACCOUNT}:${candidate.id}` === id);
      if (!spec) throw new Error('unknown item');
      return rawItem(spec);
    },
    classificationSignals() {
      return {};
    },
  };
}
