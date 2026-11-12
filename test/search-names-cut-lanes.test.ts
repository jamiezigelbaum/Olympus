// A search lane cut short is named in the search result's notes, never a
// silently thinner list. A store whose reader is busy (another read holds its
// pool thread, or the lane's deadline passes) leaves its lane out as a lane
// timeout; olympus_search must say which source by corpus id, beside the
// evidence the other sources still gave, the way an answer already does
// (#1305, #1317). A chat source whose read of its newest items runs out of
// time is still searched by its other lanes, and is named too (#1460).

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { laneTimeoutGap, recentItemsTimeoutGap, semanticTimeoutGap, visibilityCheckTimeoutGap } from '../src/core/source-index/partial-search.ts';
import { LocalConnectorStore, createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { OffThreadReadBusyError, setReadPoolClockForTests, setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const READ = 'internal.fake.notes';
const HELD = 'internal.fake.chats';
const ACCOUNT = 'personal';

afterEach(() => {
  setReadPoolClockForTests();
  setReadPoolObserverForTests();
});

function notes(result: ReturnType<typeof searchToolResult>): string[] {
  return (result.structuredContent as { notes: string[] }).notes;
}

describe('olympus_search names every lane it cut short', () => {
  test('a store whose reader is held is named with its reason, beside the evidence the others gave', async () => {
    const store = await noteStore();
    const raw = await searchReleasedEvidence({
      question: 'orchard',
      maxResults: 10,
      lanes: () => ({
        registry: buildSourceIndexCorpusRegistry([
          defineConnectorCorpus({ corpusId: READ, family: 'file', trustDomain: 'internal' }),
          defineConnectorCorpus({ corpusId: HELD, family: 'chat', trustDomain: 'internal' }),
        ]),
        adapters: {
          [READ]: createConnectorStoreCorpusAdapter({ store }),
          // What the read pool gives a lane while a status read holds the store's reader.
          [HELD]: async () => { throw new OffThreadReadBusyError(); },
        },
        contentProviders: { [READ]: createConnectorStoreContentProvider({ store }) },
      }),
    });
    expect(raw.evidence.length).toBeGreaterThan(0);
    expect(raw.coverage.cut_short).toEqual([laneTimeoutGap(HELD)]);

    const result = searchToolResult(raw);
    expect(notes(result)).toContain(laneTimeoutGap(HELD));
    expect(result.content[0]!.text).toContain(`Ran out of time searching ${HELD}`);
    expect((result.structuredContent as { evidence: unknown[] }).evidence.length).toBe(raw.evidence.length);
    store.close();
  });

  test('a chat store whose newest-items read runs out of time is named, and its keyword matches still come back', async () => {
    const store = await chatStore();
    // The pool's clock jumps an hour the moment the newest-items read is sent,
    // so that read (and only it) comes back past its deadline: what a held
    // reader does to the last read of the lane.
    let offsetMs = 0;
    setReadPoolClockForTests({
      now: () => Date.now() + offsetMs,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
    let held = 0;
    setReadPoolObserverForTests((_dbPath, read) => {
      if (read.sql.includes('ORDER BY COALESCE(i.authored_at, i.updated_at, i.indexed_at) DESC')) {
        held += 1;
        offsetMs = 60 * 60_000;
      }
    });
    const raw = await searchReleasedEvidence({
      question: 'orchard',
      maxResults: 10,
      lanes: () => ({
        registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId: HELD, family: 'chat', trustDomain: 'internal' })]),
        adapters: { [HELD]: createConnectorStoreCorpusAdapter({ store }) },
        contentProviders: { [HELD]: createConnectorStoreContentProvider({ store }) },
      }),
    });
    setReadPoolClockForTests();
    expect(held).toBe(1);
    expect(raw.evidence.length).toBeGreaterThan(0);
    expect(raw.coverage.cut_short).toEqual([recentItemsTimeoutGap(HELD)]);
    expect(notes(searchToolResult(raw))).toContain(recentItemsTimeoutGap(HELD));
    store.close();
  });

  test('a tiered source whose privacy check finds the read pool busy is named, and its matches are left out (#1460)', async () => {
    const notesStore = await noteStore();
    const { dir, cleanup } = tempDir('search-cut-visibility-');
    const fixture = openTierFixture(dir, { embed: false });
    try {
      await fixture.set.sync(fixtureConnector(() => [{ id: 'garden', name: 'orchard garden.txt', text: 'The orchard garden needs compost.' }]),
        { fetchContent: true, placement: FIXTURE_PLACEMENT });
      const tiered = fixture.stores.internal!;
      const lanes = () => ({
        registry: buildSourceIndexCorpusRegistry([
          defineConnectorCorpus({ corpusId: READ, family: 'file', trustDomain: 'internal' }),
          defineConnectorCorpus({ corpusId: tiered.corpusId, family: tiered.family, trustDomain: 'internal' }),
        ]),
        adapters: {
          [READ]: createConnectorStoreCorpusAdapter({ store: notesStore }),
          [tiered.corpusId]: createConnectorStoreCorpusAdapter({ store: tiered }),
        },
        contentProviders: {
          [READ]: createConnectorStoreContentProvider({ store: notesStore }),
          [tiered.corpusId]: createConnectorStoreContentProvider({ store: tiered }),
        },
        visibilityGate: createTierVisibilityGate(() => [{ ledger: fixture.ledger, corpusIds: new Set(Object.values(CORPORA)) }]),
      });
      const before = await searchReleasedEvidence({ question: 'orchard', maxResults: 10, lanes });
      expect(before.coverage.cut_short).toBeUndefined();
      expect(JSON.stringify(before.evidence)).toContain('orchard garden');

      // Only the gate's ledger read finds the pool busy: what a status read
      // holding the ledger's reader does to the search's final privacy check.
      let gateReads = 0;
      const steps = fixture.ledger.visibilityReadSteps.bind(fixture.ledger);
      spyOn(fixture.ledger, 'visibilityReadSteps').mockImplementation((identities, options) => {
        if (identities.some((identity) => identity.providerItemId === 'garden') && options?.personalFirst === false) {
          gateReads += 1;
          throw new OffThreadReadBusyError();
        }
        return steps(identities, options);
      });
      const raw = await searchReleasedEvidence({ question: 'orchard', maxResults: 10, lanes });
      expect(gateReads).toBeGreaterThan(0);
      expect(JSON.stringify(raw.evidence)).not.toContain('orchard garden');
      expect(raw.evidence.length).toBeGreaterThan(0);
      expect(raw.coverage.cut_short).toEqual([visibilityCheckTimeoutGap(CORPORA.internal)]);
      expect(notes(searchToolResult(raw))).toContain(visibilityCheckTimeoutGap(CORPORA.internal));
    } finally {
      notesStore.close();
      fixture.close();
      cleanup();
    }
  });

  test('a lane searched by keyword only is named too, and a full search adds no note', () => {
    const partly = searchToolResult({ evidence: [], coverage: { searched_corpora: 2, cut_short: [semanticTimeoutGap(HELD)] } });
    expect(notes(partly)).toContain(semanticTimeoutGap(HELD));
    const full = searchToolResult({ evidence: [], coverage: { searched_corpora: 2 } });
    expect(notes(full).join(' ')).not.toContain('Ran out of time');
  });
});

async function noteStore(): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'search-cut-lanes-')), 'store.sqlite'),
    corpusId: READ,
    family: 'file',
    trustDomain: 'internal',
  });
  await store.syncFromConnector(connector(), { fetchContent: true });
  return store;
}

async function chatStore(): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'search-cut-recency-')), 'store.sqlite'),
    corpusId: HELD,
    family: 'chat',
    trustDomain: 'internal',
  });
  const message = (id: string, text: string, sentAt: string): RawItem => ({
    identity: { family: 'chat', provider: 'fake_chat', accountScope: ACCOUNT, providerItemId: id, localItemId: `${ACCOUNT}:${id}`, sourceVersion: 'v1' },
    mimeType: 'text/plain',
    content: { kind: 'text', text },
    metadata: Object.freeze({ sentAt }),
    fetchedAt: sentAt,
  });
  const items = [
    message('old', 'The orchard needs pruning in winter.', '2026-07-01T10:00:00.000Z'),
    message('new', 'See you at the harbour tomorrow.', '2026-07-05T22:00:00.000Z'),
  ];
  await store.syncFromConnector({
    id: 'fake_chat_connector',
    family: 'chat',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(id: string): Promise<RawItem> { return items.find((item) => item.identity.localItemId === id)!; },
    classificationSignals() { return {}; },
  }, { fetchContent: true });
  return store;
}

function rawItem(): RawItem {
  return {
    identity: { family: 'file', provider: 'fake_files', accountScope: ACCOUNT, providerItemId: 'plan', localItemId: `${ACCOUNT}:plan`, providerFileId: 'plan' },
    mimeType: 'text/markdown',
    content: { kind: 'text', text: 'Orchard plan: prune in winter.' },
    metadata: { name: 'orchard plan.md', locatorUri: '/notes/orchard plan.md' },
    fetchedAt: '2026-10-01T12:00:00.000Z',
  };
}

function connector(): SourceConnector {
  return {
    id: 'fake_files_connector',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: [rawItem()], done: true };
      })();
    },
    async fetchItem(): Promise<RawItem> { return rawItem(); },
    classificationSignals() { return {}; },
  };
}
