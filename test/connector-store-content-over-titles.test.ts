// Content-bearing evidence outranks bare file names.
//
// Mirrors the shape a first-time Dropbox install produced on 2026-09-22: 599
// items, of which only two PDFs had extracted text; everything else was a
// title/path-only row, folders included. Keyword search ranked the folder
// first and a wall of title-only /books rows after it, the PDFs fell outside
// the 18-row lane that source_answer fetches, and the answer's evidence was a
// contentless folder. These tests pin the repaired ranking at the adapter, the
// worker search route, and the source_answer evidence pack.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { analystPromptBytes, createAnalyst, redactPackForEscalation } from '../src/core/analyst.ts';
import type { EvidenceCandidate, EvidencePack } from '../src/core/contracts.ts';
import { buildEvidencePack, utf8ByteLength } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { buildSourceSensitivity, type SourceTrustDomain } from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { DROPBOX_FILES_CORPUS_ID } from '../src/workers/dropbox-files/index.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createAnalystSourceIndexAnswerHandler, fitPackToPromptBytes } from '../src/workers/source-index/analyst-answer.ts';
import type {
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';
const NOTES_CORPUS_ID = 'internal.fake.notes';

interface FixtureItem {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  text?: string;
}

const FOLDER: FixtureItem = {
  id: 'dir-integral',
  name: 'Integral Theory',
  path: '/books/Integral Theory',
  mimeType: 'inode/directory',
};

// Title-only rows: names and paths say "integral theory" and "ken wilber"
// louder than any document body can. More of them than an 18-row lane holds.
const TITLE_ONLY: FixtureItem[] = Array.from({ length: 30 }, (_, index) => ({
  id: `title-${index}`,
  name: `Ken Wilber Integral Theory Integral Psychology volume ${index}.epub`,
  path: `/books/Integral Theory/Ken Wilber Integral Theory Integral Psychology volume ${index}.epub`,
  mimeType: 'application/epub+zip',
}));

const BRIEF_HISTORY: FixtureItem = {
  id: 'title-brief-history',
  name: 'A Brief History of Everything.epub',
  path: '/books/Wilber/A Brief History of Everything.epub',
  mimeType: 'application/epub+zip',
};

const SPIRAL: FixtureItem = {
  id: 'title-spiral',
  name: 'Spiral Dynamics.epub',
  path: '/books/Spiral Dynamics.epub',
  mimeType: 'application/epub+zip',
};

const PDF_A: FixtureItem = {
  id: 'pdf-a',
  name: 'seminar-reader.pdf',
  path: '/reading/seminar-reader.pdf',
  mimeType: 'application/pdf',
  text: 'Integral theory, as Ken Wilber frames it, maps every perspective into four quadrants of experience.',
};

const PDF_B: FixtureItem = {
  id: 'pdf-b',
  name: 'course-notes.pdf',
  path: '/reading/course-notes.pdf',
  mimeType: 'application/pdf',
  text: 'Holons nest within holons; integral theory treats development as transcend and include.',
};

const DRIVE_FOLDER: FixtureItem = {
  id: 'drive-folder-integral',
  name: 'Integral Theory Drive Folder',
  path: '/drive/Integral Theory',
  mimeType: 'application/vnd.google-apps.folder',
};

const CORPUS_ITEMS = [FOLDER, DRIVE_FOLDER, ...TITLE_ONLY, BRIEF_HISTORY, SPIRAL, PDF_A, PDF_B];

describe('connector-store ranking: content over titles', () => {
  test('keyword search ranks content PDFs above title-only rows and never returns the folder', async () => {
    await withStores(async ({ store }) => {
      const integral = hitIds(await search(store, 'integral theory', { retrievalMode: 'keyword', maxResults: 5 }));
      expect(integral.slice(0, 2).sort()).toEqual(['pdf-a', 'pdf-b']);
      expect(integral).not.toContain('dir-integral');
      expect(integral).not.toContain('drive-folder-integral');
      expect(integral.length).toBe(5);

      // Only PDF A's body names Wilber; it leads, and the title-only rows follow.
      const wilber = hitIds(await search(store, 'ken wilber', { retrievalMode: 'keyword', maxResults: 5 }));
      expect(wilber[0]).toBe('pdf-a');
      expect(wilber).not.toContain('dir-integral');
    });
  });

  test('hybrid search ranks content first and never returns the folder', async () => {
    await withStores(async ({ store, provider }) => {
      for (const query of ['integral theory', 'ken wilber']) {
        const ids = hitIds(await search(store, query, { retrievalMode: 'hybrid', maxResults: 5, provider, semanticRelevanceBar: 0.62 }));
        expect({ query, top: ids.slice(0, 2).sort() }).toEqual({ query, top: ['pdf-a', 'pdf-b'] });
        expect(ids).not.toContain('dir-integral');
      }
    });
  });

  test('a vetted vector hit on real content beats a keyword hit on a bare file name at the same rank', async () => {
    await withStores(async ({ store, provider }) => {
      // Neither PDF says "spiral"; the only keyword hit is a title-only row.
      // The vector lane places PDF A first, which ties that title in RRF.
      // With a relevance bar for this model, PDF A (cosine 1.0) is vetted.
      const vetted = hitIds(await search(store, 'spiral dynamics', {
        retrievalMode: 'hybrid', maxResults: 3, provider, semanticRelevanceBar: 0.62,
      }));
      expect(vetted[0]).toBe('pdf-a');
      // The title-only row stays findable below the content.
      expect(vetted).toContain('title-spiral');

      // An embedding model with no calibrated bar gets no vector content
      // preference: ranking fails soft to lexical-first, and the title leads.
      const uncalibrated = hitIds(await search(store, 'spiral dynamics', { retrievalMode: 'hybrid', maxResults: 3, provider }));
      expect(uncalibrated[0]).toBe('title-spiral');
      expect(uncalibrated).toContain('pdf-a');
    });
  });

  test('a title-only lookup still finds the file when no content matches', async () => {
    await withStores(async ({ store, provider }) => {
      const response = await search(store, 'brief history everything', { retrievalMode: 'keyword', maxResults: 5 });
      expect(hitIds(response)[0]).toBe('title-brief-history');
      // Hybrid too, with one result: a weak vector neighbour (below the
      // relevance bar) gets no content preference over the exact title.
      for (const maxResults of [1, 5]) {
        const hybrid = await search(store, 'brief history everything', { retrievalMode: 'hybrid', maxResults, provider });
        expect({ maxResults, top: hitIds(hybrid)[0] }).toEqual({ maxResults, top: 'title-brief-history' });
      }
    });
  });

  test('containers from any source are never results', async () => {
    await withStores(async ({ store, provider }) => {
      for (const retrievalMode of ['keyword', 'hybrid'] as const) {
        const ids = hitIds(await search(store, 'integral theory drive folder', { retrievalMode, maxResults: 50, provider }));
        expect({ retrievalMode, ids: ids.filter((id) => id.includes('folder') || id.startsWith('dir-')) })
          .toEqual({ retrievalMode, ids: [] });
      }
    });
  });

  test('a multi-concept match count is a lower bound when the raw fetch hit its ceiling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-count-probe-'));
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'files.sqlite'),
      corpusId: DROPBOX_FILES_CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    try {
      // 300 noise items say only one concept, loudly; 60 long real matches say both
      // concepts once. The raw fetch fills with noise, the minimum-signal
      // filter leaves few rows, and those few are not the whole match set.
      const noise = Array.from({ length: 300 }, (_, index) => {
        const term = index % 2 === 0 ? 'integral' : 'theory';
        return {
          id: `noise-${index}`,
          name: `${term} ${term} ${term} ${index}.md`,
          path: `/noise/${term} ${term} ${term} ${index}.md`,
          mimeType: 'text/markdown',
          text: `${term} ${term} ${term} ${term} ${term} ${term}`,
        };
      });
      const matches = Array.from({ length: 60 }, (_, index) => ({
        id: `match-${index}`,
        name: `reading ${index}.md`,
        path: `/reading/${index}.md`,
        mimeType: 'text/markdown',
        text: `Reading list entry ${index}: one mention of integral and of theory. ${'Gardens need water and light in spring. '.repeat(30)}`,
      }));
      await store.syncFromConnector(fixtureConnector('dropbox', 'secure_local', [...noise, ...matches]), { fetchContent: true });
      const response = await search(store, 'integral theory', { retrievalMode: 'keyword', maxResults: 10 });
      expect(response.matchCount?.saturated).toBe(true);
      // Fewer than the 50-row probe survived the filter, so the old
      // post-filter test would have reported this count as exact.
      expect(response.matchCount!.matchedItems).toBeLessThan(50);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('private match counts never reach a pack without private evidence', async () => {
    await withStores(async ({ notesStore, provider }) => {
      const registry = buildSourceIndexCorpusRegistry([
        defineConnectorCorpus({ corpusId: DROPBOX_FILES_CORPUS_ID, family: 'file', trustDomain: 'secure_local' }),
        defineConnectorCorpus({ corpusId: NOTES_CORPUS_ID, family: 'file', trustDomain: 'internal' }),
      ]);
      const pack = await buildEvidencePack({
        question: 'What does integral theory say?',
        maxResults: 5,
        searchContext: { allowedTrustDomains: ['internal', 'secure_local'] },
        registry,
        adapters: {
          // Counts matches but returns no hits: the pack holds no private evidence.
          [DROPBOX_FILES_CORPUS_ID]: () => ({
            hits: [],
            latencyMs: 0,
            matchCount: { matchedItems: 7, contentMatchedItems: 2, saturated: false },
            rawExposed: false,
          }),
          [NOTES_CORPUS_ID]: createConnectorStoreCorpusAdapter({ store: notesStore, embeddingProvider: provider, retrievalMode: 'hybrid' }),
        },
        contentProviders: { [NOTES_CORPUS_ID]: createConnectorStoreContentProvider({ store: notesStore }) },
      });
      expect(pack.candidates.every((candidate) => candidate.trustDomain === 'internal')).toBe(true);
      expect(pack.coverage.matchCounts?.map((count) => count.corpusId)).toEqual([NOTES_CORPUS_ID]);
      // And an escalation pack carries no match counts at all.
      expect(redactPackForEscalation({
        ...pack,
        coverage: { ...pack.coverage, matchCounts: [{ corpusId: DROPBOX_FILES_CORPUS_ID, family: 'file', matchedItems: 7, contentMatchedItems: 2, atLeast: false, inEvidence: 1 }] },
      }).coverage.matchCounts).toBeUndefined();
    });
  });

  test('source_answer evidence at the default budget carries a content PDF, not a folder or title', async () => {
    await withStores(async ({ store, notesStore, provider }) => {
      const registry = buildSourceIndexCorpusRegistry([
        defineConnectorCorpus({ corpusId: store.corpusId, family: 'file', trustDomain: 'secure_local' }),
        defineConnectorCorpus({ corpusId: NOTES_CORPUS_ID, family: 'file', trustDomain: 'internal' }),
      ]);
      const pack = await buildEvidencePack({
        question: 'What does integral theory say?',
        searchQuery: 'integral theory',
        // A tight budget: three seats across two sources.
        maxResults: 3,
        searchContext: { allowedTrustDomains: ['public_safe', 'internal', 'secure_local'] },
        registry,
        adapters: {
          [store.corpusId]: createConnectorStoreCorpusAdapter({ store, embeddingProvider: provider, retrievalMode: 'hybrid' }),
          [NOTES_CORPUS_ID]: createConnectorStoreCorpusAdapter({ store: notesStore, embeddingProvider: provider, retrievalMode: 'hybrid' }),
        },
        contentProviders: {
          [store.corpusId]: createConnectorStoreContentProvider({ store }),
          [NOTES_CORPUS_ID]: createConnectorStoreContentProvider({ store: notesStore }),
        },
      });
      const secure = pack.candidates.filter((candidate) => candidate.trustDomain === 'secure_local');
      expect(secure.length).toBeGreaterThan(0);
      expect(['pdf-a', 'pdf-b']).toContain(secure[0]!.provenance.sourceItem.providerItemId);
      expect(secure[0]!.chunks.join(' ')).toContain('integral theory');
      expect(pack.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId))
        .not.toContain('dir-integral');
      // Both contributing sources are represented.
      expect(pack.candidates.some((candidate) => candidate.trustDomain === 'internal')).toBe(true);
      // Breadth rides beside the bounded evidence: the Dropbox corpus matched
      // both PDFs and 30 title-only rows (the folder is not a match).
      const dropbox = pack.coverage.matchCounts?.find((count) => count.corpusId === store.corpusId);
      expect(dropbox).toMatchObject({ family: 'file', matchedItems: 32, contentMatchedItems: 2, atLeast: false });
      expect(dropbox!.inEvidence).toBeGreaterThan(0);
    });
  });

  test('a broad question gets a budgeted pack: dozens of passages, every source seated, breadth counted', async () => {
    await withStores(async ({ store, provider }) => {
      const dir = mkdtempSync(join(tmpdir(), 'olympus-broad-evidence-'));
      const mail = new LocalConnectorStore({
        dbPath: join(dir, 'mail.sqlite'),
        corpusId: 'internal.fake.mail',
        family: 'file',
        trustDomain: 'internal',
      });
      try {
        await mail.syncFromConnector(fixtureConnector('fake_mail', 'internal', Array.from({ length: 60 }, (_, index) => ({
          id: `mail-${index}`,
          name: `Re: reading list ${index}`,
          path: `/mail/${index}`,
          mimeType: 'message/rfc822',
          text: `Message ${index}: another note on integral theory for the reading group.`,
        }))), { fetchContent: true });
        const registry = buildSourceIndexCorpusRegistry([
          defineConnectorCorpus({ corpusId: store.corpusId, family: 'file', trustDomain: 'secure_local' }),
          defineConnectorCorpus({ corpusId: mail.corpusId, family: 'file', trustDomain: 'internal' }),
        ]);
        const fetches: number[] = [];
        const counting = (inner: ReturnType<typeof createConnectorStoreContentProvider>) => ({
          async fetchLocalContent(request: Parameters<typeof inner.fetchLocalContent>[0]) {
            fetches.push(request.maxChars ?? 0);
            return inner.fetchLocalContent(request);
          },
        });
        const pack = await buildEvidencePack({
          question: 'What do I have in my files about integral theory?',
          searchQuery: 'integral theory',
          maxResults: 24,
          evidenceByteBudget: 40_000,
          maxCharsPerCandidate: 3_000,
          searchContext: { allowedTrustDomains: ['public_safe', 'internal', 'secure_local'] },
          registry,
          adapters: {
            [store.corpusId]: createConnectorStoreCorpusAdapter({ store, embeddingProvider: provider, retrievalMode: 'hybrid' }),
            [mail.corpusId]: createConnectorStoreCorpusAdapter({ store: mail, retrievalMode: 'keyword' }),
          },
          contentProviders: {
            [store.corpusId]: counting(createConnectorStoreContentProvider({ store })),
            [mail.corpusId]: counting(createConnectorStoreContentProvider({ store: mail })),
          },
        });
        expect(pack.candidates).toHaveLength(24);
        expect(fetches.every((maxChars) => maxChars === Math.floor(40_000 / 24))).toBe(true);
        const bySource = new Map<string, number>();
        for (const candidate of pack.candidates) {
          bySource.set(candidate.trustDomain, (bySource.get(candidate.trustDomain) ?? 0) + 1);
        }
        expect(bySource.get('secure_local')).toBeGreaterThanOrEqual(2);
        expect(bySource.get('internal')).toBeGreaterThanOrEqual(12);
        const mailCount = pack.coverage.matchCounts?.find((count) => count.corpusId === mail.corpusId);
        // 60 matching messages exceed the 50-row probe: a lower bound.
        expect(mailCount).toMatchObject({ matchedItems: 50, atLeast: true });
      } finally {
        mail.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test('a long document contributes its matching passage, not its opening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-passage-'));
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'files.sqlite'),
      corpusId: DROPBOX_FILES_CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    try {
      const filler = Array.from({ length: 400 }, (_, index) => `Filler sentence ${index} about unrelated gardening.`).join(' ');
      await store.syncFromConnector(fixtureConnector('dropbox', 'secure_local', [{
        id: 'long-pdf',
        name: 'long.pdf',
        path: '/reading/long.pdf',
        mimeType: 'application/pdf',
        text: `${filler} The holarchy chapter explains transcend and include. ${filler}`,
      }]), { fetchContent: true });
      const content = await createConnectorStoreContentProvider({ store }).fetchLocalContent({
        provenance: {
          sourceItem: {
            family: 'file',
            provider: 'dropbox',
            accountScope: ACCOUNT,
            providerItemId: 'long-pdf',
            localItemId: `${ACCOUNT}:long-pdf`,
          },
        },
        trustDomain: 'secure_local',
        maxChars: 600,
        query: 'holarchy chapter',
      });
      expect(content!.chunks.join(' ')).toContain('holarchy chapter');
      expect(content!.chunks.join('').length).toBeLessThanOrEqual(600);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the worker search route defaults to hybrid when the corpus has current embeddings', async () => {
    await withStores(async ({ store, provider }) => {
      const embedded = createEmailSourceWorker({
        connectorStores: [store],
        connectorStorePrincipals: new Map([[DROPBOX_FILES_CORPUS_ID, { provider: 'dropbox', accountScope: ACCOUNT }]]),
        connectorStoreEmbeddingProviders: new Map([[DROPBOX_FILES_CORPUS_ID, provider]]),
      });
      const hybrid = await workerSearch(embedded, { query: 'spiral dynamics' });
      expect(hybrid.status).toBe(200);
      expect(laneTypes(hybrid.body)).toContain('hybrid');
      // The semantic lane ran: PDF A shares no word with the query.
      expect(hybrid.body.hits.map((hit: { sourceItem: { providerItemId: string } }) => hit.sourceItem.providerItemId))
        .toContain('pdf-a');

      // An explicit keyword pin is still honored.
      const pinned = await workerSearch(embedded, { query: 'spiral dynamics', retrieval_mode: 'keyword' });
      expect(laneTypes(pinned.body)).not.toContain('hybrid');

      // No embedding provider: keyword, with no skipped-lane marker for a
      // lane nobody asked for.
      const plain = createEmailSourceWorker({
        connectorStores: [store],
        connectorStorePrincipals: new Map([[DROPBOX_FILES_CORPUS_ID, { provider: 'dropbox', accountScope: ACCOUNT }]]),
      });
      const keyword = await workerSearch(plain, { query: 'integral theory' });
      expect(keyword.status).toBe(200);
      expect(laneTypes(keyword.body)).toEqual(['keyword']);
      expect(keyword.body.audit.lane_audits[0].skippedReason).toBeUndefined();
    });
  });
});

// --- Fixtures -------------------------------------------------------------------

type SearchStore = LocalConnectorStore;

async function withStores(run: (input: {
  store: SearchStore;
  notesStore: SearchStore;
  provider: SourceEmbeddingProvider;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-content-over-titles-'));
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'dropbox.sqlite'),
    corpusId: DROPBOX_FILES_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  const notesStore = new LocalConnectorStore({
    dbPath: join(dir, 'notes.sqlite'),
    corpusId: NOTES_CORPUS_ID,
    family: 'file',
    trustDomain: 'internal',
  });
  const provider = embeddingProvider();
  try {
    await store.syncFromConnector(fixtureConnector('dropbox', 'secure_local', CORPUS_ITEMS), { fetchContent: true });
    await notesStore.syncFromConnector(fixtureConnector('fake_notes', 'internal', [{
      id: 'note-1',
      name: 'reading-group.md',
      path: '/notes/reading-group.md',
      mimeType: 'text/markdown',
      text: 'Reading group agreed to start integral theory next month.',
    }]), { fetchContent: true });
    await store.embedChunks({ provider });
    await notesStore.embedChunks({ provider });
    await run({ store, notesStore, provider });
  } finally {
    store.close();
    notesStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixtureConnector(
  provider: string,
  trustDomain: SourceTrustDomain,
  items: readonly FixtureItem[],
): SourceConnector {
  const rawItems = items.map((item): RawItem => ({
    identity: {
      family: 'file',
      provider,
      accountScope: ACCOUNT,
      providerItemId: item.id,
      providerFileId: item.id,
      localItemId: `${ACCOUNT}:${item.id}`,
      sourceVersion: `${item.id}:v1`,
    },
    mimeType: item.mimeType,
    content: item.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: item.text },
    metadata: Object.freeze({
      name: item.name,
      locatorUri: item.path,
      pathDisplay: item.path,
      updatedAt: '2026-09-22T10:00:00.000Z',
    }),
    fetchedAt: '2026-09-22T10:00:00.000Z',
  }));
  const byId = new Map(rawItems.map((item) => [item.identity.localItemId, item]));
  return {
    id: `${provider}-content-over-titles`,
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
    classify() {
      return buildSourceSensitivity({ trustTier: trustDomain === 'secure_local' ? 'S4' : 'S3', trustDomain });
    },
  };
}

// Concept axes: [integral theory, everything else]. PDF A sits exactly on the
// query axis so its vector rank is deterministic.
function embeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'content-over-titles-fixture',
    modelId: 'content-over-titles-v1',
    dimension: 2,
    configHash: 'content-over-titles-config',
    epochId: 'local:content-over-titles-fixture:content-over-titles-v1:2',
    backend: 'local',
    async embed(inputs: SourceEmbeddingInput[], options): Promise<number[][]> {
      return inputs.map((input) => {
        const text = `${input.title ?? ''}\n${input.text}`.toLowerCase();
        // A name lookup sits off the content axis, so every document is only
        // a weak neighbour of it (PDF B at cosine 0.6, under the 0.62 bar).
        if (options.taskType === 'RETRIEVAL_QUERY') return text.includes('brief history') ? [0, 1] : [1, 0];
        if (text.includes('four quadrants')) return [1, 0];
        if (text.includes('holons')) return [0.8, 0.6];
        if (text.includes('reading group')) return [0.6, 0.8];
        return [0, 1];
      });
    },
  };
}

async function search(
  store: SearchStore,
  query: string,
  options: {
    retrievalMode: 'keyword' | 'hybrid';
    maxResults: number;
    provider?: SourceEmbeddingProvider;
    semanticRelevanceBar?: number;
  },
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

async function workerSearch(
  worker: ReturnType<typeof createEmailSourceWorker>,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
    method: 'POST',
    body: JSON.stringify({ corpus_id: DROPBOX_FILES_CORPUS_ID, max_results: 5, ...body }),
    headers: { 'Content-Type': 'application/json' },
  }));
  return { status: response.status, body: await response.json() };
}

function laneTypes(body: Record<string, any>): string[] {
  return (body.audit?.lane_audits ?? []).map((lane: { laneType: string }) => lane.laneType);
}

describe('evidence byte budget', () => {
  test('24 CJK candidates with CJK labels stay under the OpenClaw 100,000-byte prompt ceiling', async () => {
    const cjk = '整合理論は四つの象限で経験を捉える。';
    const registry = buildSourceIndexCorpusRegistry([
      defineConnectorCorpus({ corpusId: NOTES_CORPUS_ID, family: 'file', trustDomain: 'internal' }),
    ]);
    const ids = Array.from({ length: 24 }, (_, index) => `cjk-${index}`);
    const pack = await buildEvidencePack({
      question: '整合理論について何がありますか？',
      maxResults: 24,
      evidenceByteBudget: 40_000,
      maxCharsPerCandidate: 3_000,
      searchContext: { allowedTrustDomains: ['internal'] },
      registry,
      adapters: {
        [NOTES_CORPUS_ID]: () => ({
          hits: ids.map((id) => ({
            sourceItem: { family: 'file' as const, provider: 'fixture', accountScope: ACCOUNT, providerItemId: id, localItemId: `${ACCOUNT}:${id}` },
            provenance: {
              sourceItem: { family: 'file' as const, provider: 'fixture', accountScope: ACCOUNT, providerItemId: id, localItemId: `${ACCOUNT}:${id}` },
              citation: { title: `${cjk}${cjk} ${id}`, uri: `/資料/${cjk}/${id}.pdf`, authorLabel: cjk, authoredAt: '2026-09-01T00:00:00Z' },
            },
            score: 1,
            rawExposed: false as const,
          })),
          latencyMs: 0,
          rawExposed: false,
        }),
      },
      contentProviders: {
        [NOTES_CORPUS_ID]: {
          async fetchLocalContent(request) {
            return {
              sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
              chunks: [cjk.repeat(Math.ceil((request.maxChars ?? 3_000) / cjk.length)).slice(0, request.maxChars ?? 3_000)],
            };
          },
        },
      },
    });
    const passageBytes = pack.candidates.reduce((sum, candidate) => sum + candidate.chunks.reduce((inner, chunk) => inner + utf8ByteLength(chunk), 0), 0);
    expect(pack.candidates).toHaveLength(24);
    expect(passageBytes).toBeLessThanOrEqual(40_000);
    for (const localOnly of [false, true]) {
      let promptBytes = 0;
      await createAnalyst({
        async complete(request) {
          promptBytes = utf8ByteLength(`${request.system}\n\n${request.prompt}`);
          return { text: JSON.stringify({ answer: 'x', citations: [{ evidence: 1, claim: 'x' }], unanswered: [], sufficient: true }), modelId: 'm' };
        },
      }).analyze(pack, { localOnly });
      expect({ localOnly, under: promptBytes < 100_000 }).toEqual({ localOnly, under: true });
    }
  });

  test('a pack is fitted by TOTAL prompt bytes, every corpus still seated', () => {
    const candidate = (id: string, text: string): EvidenceCandidate => ({
      provenance: {
        sourceItem: { family: 'file', provider: 'fixture', accountScope: ACCOUNT, providerItemId: id, localItemId: id },
        citation: {
          title: `A fairly long document title for ${id} about integral theory and practice`,
          uri: `/Users/someone/Dropbox/Reading/Integral Theory/${id}.pdf`,
          authorLabel: 'Someone Example',
          authoredAt: '2026-09-01T00:00:00Z',
        },
      },
      trustTier: 'S4',
      trustDomain: 'secure_local',
      chunks: [text],
    });
    const mail = Array.from({ length: 20 }, (_, index) => candidate(`mail-${index}`, 'm'.repeat(1_666)));
    const files = Array.from({ length: 4 }, (_, index) => candidate(`file-${index}`, 'f'.repeat(1_666)));
    const pack: EvidencePack = {
      question: 'q',
      candidates: [...mail, ...files],
      coverage: {
        searchedCorpora: ['mail', 'files'],
        skippedCorpora: [],
        extractionGaps: [],
        matchCounts: [
          { corpusId: 'mail', family: 'email', matchedItems: 50, contentMatchedItems: 50, atLeast: true, inEvidence: 20 },
          { corpusId: 'files', family: 'file', matchedItems: 4, contentMatchedItems: 4, atLeast: false, inEvidence: 4 },
        ],
      },
      builtAt: '2026-09-23T00:00:00Z',
    };
    const corpusOf = new Map<EvidenceCandidate, string>([
      ...mail.map((c) => [c, 'mail'] as const),
      ...files.map((c) => [c, 'files'] as const),
    ]);
    const options = { localOnly: true };
    const fitted = fitPackToPromptBytes(pack, 13_500, corpusOf, options);
    // The whole prompt (system rules, labels, local provenance, passages) fits.
    expect(analystPromptBytes(fitted, options)).toBeLessThanOrEqual(13_500);
    expect(fitted.candidates.length).toBeGreaterThan(1);
    expect(fitted.candidates.some((c) => c.provenance.sourceItem.providerItemId.startsWith('file-'))).toBe(true);
    expect(fitted.candidates.some((c) => c.provenance.sourceItem.providerItemId.startsWith('mail-'))).toBe(true);
    const inEvidence = fitted.coverage.matchCounts!.reduce((sum, count) => sum + count.inEvidence, 0);
    expect(inEvidence).toBe(fitted.candidates.length);
    // A pack that already fits is untouched.
    expect(fitPackToPromptBytes(pack, 1_000_000, corpusOf, options)).toBe(pack);
  });
});

describe('local analyst leg budget', () => {
  test('the local leg receives the conservative budget unless the host declares more', async () => {
    const ids = Array.from({ length: 24 }, (_, index) => `doc-${index}`);
    const lanes = () => ({
      registry: buildSourceIndexCorpusRegistry([
        defineConnectorCorpus({ corpusId: NOTES_CORPUS_ID, family: 'file', trustDomain: 'internal' }),
      ]),
      adapters: {
        [NOTES_CORPUS_ID]: () => ({
          hits: ids.map((id) => ({
            sourceItem: { family: 'file' as const, provider: 'fixture', accountScope: ACCOUNT, providerItemId: id, localItemId: `${ACCOUNT}:${id}` },
            score: 1,
            rawExposed: false as const,
          })),
          latencyMs: 0,
          rawExposed: false as const,
        }),
      },
      contentProviders: {
        [NOTES_CORPUS_ID]: {
          async fetchLocalContent(request: { maxChars?: number }) {
            return {
              sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
              chunks: ['integral theory '.repeat(400).slice(0, request.maxChars ?? 3_000)],
            };
          },
        },
      },
    });
    for (const declared of [undefined, 60_000] as const) {
      const received: EvidencePack[] = [];
      const handler = createAnalystSourceIndexAnswerHandler({
        analyst: {
          async analyze(pack) {
            received.push(pack);
            return { answer: 'ok', citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'ok' }], unanswered: [] };
          },
        },
        lanes,
        ...(declared !== undefined ? { localAnalystPromptByteBudget: declared } : {}),
      });
      await handler.answer({ question: 'What about integral theory?' });
      const promptBytes = analystPromptBytes(received[0]!, { localOnly: false });
      // Default: at most the pre-budget local footprint (13,667 bytes measured).
      expect({ declared, fits: promptBytes <= (declared ?? 13_500) }).toEqual({ declared, fits: true });
      if (declared !== undefined) expect(received[0]!.candidates).toHaveLength(24);
      else expect(received[0]!.candidates.length).toBeLessThan(24);
    }
  });

  test('a cloud leg trims candidates to fit the OpenClaw prompt ceiling instead of failing', async () => {
    const cjk = '整合理論は四つの象限で経験を捉える。';
    const ids = Array.from({ length: 48 }, (_, index) => `cjk-${index}`);
    const received: EvidencePack[] = [];
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: { async analyze() { throw new Error('local must not run'); } },
      cloudAnalyst: {
        async analyze(pack) {
          received.push(pack);
          return { answer: 'ok', citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'ok' }], unanswered: [] };
        },
      },
      lanes: () => ({
        registry: buildSourceIndexCorpusRegistry([
          defineConnectorCorpus({ corpusId: NOTES_CORPUS_ID, family: 'file', trustDomain: 'internal' }),
        ]),
        adapters: {
          [NOTES_CORPUS_ID]: () => ({
            hits: ids.map((id) => ({
              sourceItem: { family: 'file' as const, provider: 'fixture', accountScope: ACCOUNT, providerItemId: id, localItemId: `${ACCOUNT}:${id}` },
              provenance: {
                sourceItem: { family: 'file' as const, provider: 'fixture', accountScope: ACCOUNT, providerItemId: id, localItemId: `${ACCOUNT}:${id}` },
                citation: { title: `${cjk.repeat(6)} ${id}`, uri: `/資料/${cjk.repeat(3)}/${id}.pdf`, authorLabel: cjk },
              },
              score: 1,
              rawExposed: false as const,
            })),
            latencyMs: 0,
            rawExposed: false as const,
          }),
        },
        contentProviders: {
          [NOTES_CORPUS_ID]: {
            async fetchLocalContent(request: { maxChars?: number }) {
              return {
                sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
                chunks: [cjk.repeat(200).slice(0, request.maxChars ?? 3_000)],
              };
            },
          },
        },
      }),
    });
    await handler.answer({ question: '整合理論について', max_results: 48 });
    expect(received).toHaveLength(1);
    expect(analystPromptBytes(received[0]!, { localOnly: false })).toBeLessThanOrEqual(90_000);
    expect(received[0]!.candidates.length).toBeGreaterThan(1);
  });
});
