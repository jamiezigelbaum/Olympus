import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';

const CORPUS_ID = 'secure_local.fixture.documents';
const PROVIDER = 'fixture_documents';
const ACCOUNT = 'personal';
const TRUST_DOMAIN = 'secure_local' as const;

interface FixtureDocument {
  id: string;
  text: string;
  path?: string;
  accountScope?: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('connector-store exhaustive document traversal', () => {
  test('pages every lexical match past the search cap and reads ordered full-text windows', async () => {
    const documents = Array.from({ length: 73 }, (_, index) => ({
      id: `doc-${String(index).padStart(3, '0')}`,
      text: `orchard traversal document ${index}. ${'ordered window text '.repeat(80)}`,
    }));
    const store = await fixtureStore(documents);
    const corpus = defineConnectorCorpus({ corpusId: CORPUS_ID, family: 'file', trustDomain: TRUST_DOMAIN });
    const adapter = createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword', accountScope: ACCOUNT });
    const provider = createConnectorStoreContentProvider({ store, accountScope: ACCOUNT });
    expect(adapter.documentMatches).toBeDefined();
    expect(provider.fetchDocumentWindow).toBeDefined();

    const found = [];
    let cursor: string | undefined;
    do {
      const page = await adapter.documentMatches!({
        query: 'orchard traversal',
        corpus,
        context: { allowedTrustDomains: [TRUST_DOMAIN] },
        pageSize: 11,
        maxDocuments: 100,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.status).toBe('ok');
      if (page.status !== 'ok') throw new Error(page.reason);
      found.push(...page.documents);
      cursor = page.nextCursor;
      expect(page.done).toBe(cursor === undefined);
    } while (cursor);

    expect(found).toHaveLength(73);
    expect(new Set(found.map((document) => document.sourceItem.providerItemId)).size).toBe(73);
    const selected = found.find((document) => document.sourceItem.providerItemId === 'doc-042')!;
    const windows: string[] = [];
    let windowCursor: string | undefined;
    do {
      const window = await provider.fetchDocumentWindow!({
        document: selected,
        trustDomain: TRUST_DOMAIN,
        maxChars: 97,
        ...(windowCursor ? { cursor: windowCursor } : {}),
      });
      expect(window).toBeDefined();
      windows.push(...window!.content.chunks);
      windowCursor = window!.nextCursor;
      expect(window!.done).toBe(windowCursor === undefined);
    } while (windowCursor);
    // Ingestion's canonical document text trims outer layout whitespace once;
    // traversal must reproduce that stored text exactly, without relevance
    // excerpts or reordering.
    expect(windows.join('')).toBe(documents[42]!.text.trim());
  });

  test('binds cursors and document revisions, and revalidates current scope and tombstones before text', async () => {
    const documents = [
      { id: 'first', text: 'orchard revision first body' },
      { id: 'second', text: 'orchard revision second body' },
      { id: 'outside', text: 'orchard revision outside body', accountScope: 'other' },
    ];
    const store = await fixtureStore(documents);
    const corpus = defineConnectorCorpus({ corpusId: CORPUS_ID, family: 'file', trustDomain: TRUST_DOMAIN });
    const adapter = createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword', accountScope: ACCOUNT });
    const provider = createConnectorStoreContentProvider({ store, accountScope: ACCOUNT });
    const firstPage = await adapter.documentMatches!({
      query: 'orchard revision',
      corpus,
      context: { allowedTrustDomains: [TRUST_DOMAIN] },
      pageSize: 1,
      maxDocuments: 10,
    });
    expect(firstPage.status).toBe('ok');
    if (firstPage.status !== 'ok') return;
    expect(firstPage.documents).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();
    const resumeCursor = firstPage.nextCursor;
    if (!resumeCursor) throw new Error('missing fixture cursor');

    const mismatched = await adapter.documentMatches!({
      query: 'different query',
      corpus,
      context: { allowedTrustDomains: [TRUST_DOMAIN] },
      pageSize: 1,
      maxDocuments: 10,
      cursor: resumeCursor,
    });
    expect(mismatched).toMatchObject({ status: 'invalidated', reason: 'cursor_request_mismatch' });

    const selected = firstPage.documents[0]!;
    expect(provider.documentCurrent!(selected, TRUST_DOMAIN)).toBe(true);
    expect(store.tombstoneCopy(selected.sourceItem, { connectorId: 'test-delete', trustTier: 'S5' })).toBe(true);
    expect(provider.documentCurrent!(selected, TRUST_DOMAIN)).toBe(false);
    expect(await provider.fetchDocumentWindow!({
      document: selected,
      trustDomain: TRUST_DOMAIN,
      maxChars: 100,
    })).toBeUndefined();

    const remaining = await adapter.documentMatches!({
      query: 'orchard revision',
      corpus,
      context: { allowedTrustDomains: [TRUST_DOMAIN] },
      pageSize: 1,
      maxDocuments: 10,
      cursor: resumeCursor,
    });
    expect(remaining.status).toBe('ok');
    if (remaining.status === 'ok') {
      expect(remaining.documents.map((document) => document.sourceItem.providerItemId)).toEqual(['second']);
    }
  });

  test('refuses an exhaustive claim when the active semantic match set cannot fit the declared cap', async () => {
    const store = await fixtureStore(Array.from({ length: 6 }, (_, index) => ({
      id: `semantic-${index}`,
      text: `semantic orchard document ${index}`,
    })));
    const provider = {
      provider: 'local' as const,
      backend: 'local' as const,
      modelId: 'fixture-model',
      dimension: 2,
      configHash: 'fixture-config',
      epochId: 'fixture-epoch',
      async embed(inputs: readonly { text: string }[]) {
        return inputs.map(() => [1, 0]);
      },
    };
    await store.embedChunks({ provider });
    const corpus = defineConnectorCorpus({ corpusId: CORPUS_ID, family: 'file', trustDomain: TRUST_DOMAIN });
    const adapter = createConnectorStoreCorpusAdapter({
      store,
      embeddingProvider: provider,
      retrievalMode: 'hybrid',
      semanticRelevanceBar: 0.5,
      accountScope: ACCOUNT,
    });
    const result = await adapter.documentMatches!({
      query: 'anything',
      corpus,
      context: { allowedTrustDomains: [TRUST_DOMAIN] },
      pageSize: 2,
      maxDocuments: 5,
    });
    expect(result).toMatchObject({ status: 'unsupported', reason: 'document_match_limit_exceeded' });
  });

  test('enumerates a metadata-only name but never reads it through a full-content provider', async () => {
    const store = await fixtureStore([
      { id: 'orchard-full', text: 'orchard full content', path: '/full/orchard-full.txt' },
      { id: 'orchard-names', text: 'orchard names-only hidden body', path: '/names/orchard-names.txt' },
    ]);
    const corpus = defineConnectorCorpus({ corpusId: CORPUS_ID, family: 'file', trustDomain: TRUST_DOMAIN });
    const adapter = createConnectorStoreCorpusAdapter({
      store,
      retrievalMode: 'keyword',
      accountScope: ACCOUNT,
      filters: { metadataOnlyLocatorPathScopes: ['/names'] },
    });
    const provider = createConnectorStoreContentProvider({
      store,
      accountScope: ACCOUNT,
      filters: { locatorPathExcludedScopes: ['/names'] },
      metadataFilters: { locatorPathScope: '/' },
    });
    const page = await adapter.documentMatches!({
      query: 'orchard',
      corpus,
      context: { allowedTrustDomains: [TRUST_DOMAIN] },
      pageSize: 10,
      maxDocuments: 10,
    });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') return;
    expect(page.documents.map((document) => document.sourceItem.providerItemId).sort())
      .toEqual(['orchard-full', 'orchard-names']);
    const full = page.documents.find((document) => document.sourceItem.providerItemId === 'orchard-full')!;
    const names = page.documents.find((document) => document.sourceItem.providerItemId === 'orchard-names')!;
    expect(provider.documentCurrent!(full, TRUST_DOMAIN)).toBe(true);
    expect(provider.documentCurrent!(names, TRUST_DOMAIN)).toBe(false);
    expect(await provider.fetchDocumentWindow!({ document: names, trustDomain: TRUST_DOMAIN, maxChars: 100 }))
      .toBeUndefined();
  });
});

async function fixtureStore(documents: readonly FixtureDocument[]): Promise<LocalConnectorStore> {
  const dir = mkdtempSync(join(tmpdir(), 'connector-document-traversal-'));
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'store.sqlite'),
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: TRUST_DOMAIN,
  });
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await store.syncFromConnector(fixtureConnector(documents), { fetchContent: true });
  return store;
}

function fixtureConnector(documents: readonly FixtureDocument[]): SourceConnector {
  const items = documents.map(rawItem);
  return {
    id: 'fixture-document-connector',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string) {
      const item = items.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!item) throw new Error('unknown fixture item');
      return item;
    },
    classificationSignals() { return {}; },
  };
}

function rawItem(document: FixtureDocument): RawItem {
  const accountScope = document.accountScope ?? ACCOUNT;
  return {
    identity: {
      family: 'file',
      provider: PROVIDER,
      accountScope,
      providerItemId: document.id,
      providerFileId: document.id,
      localItemId: `${accountScope}:${document.id}`,
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: document.text },
    metadata: {
      name: `${document.id}.txt`,
      locatorUri: document.path ?? `/documents/${document.id}.txt`,
    },
    fetchedAt: '2026-10-13T12:00:00.000Z',
  };
}
