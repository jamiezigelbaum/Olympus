// A search lane cut short is named in the search result's notes, never a
// silently thinner list. A store whose reader is busy (another read holds its
// pool thread, or the lane's deadline passes) leaves its lane out as a lane
// timeout; olympus_search must say which source by corpus id, beside the
// evidence the other sources still gave, the way an answer already does
// (#1305, #1317).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { laneTimeoutGap, semanticTimeoutGap } from '../src/core/source-index/partial-search.ts';
import { LocalConnectorStore, createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { OffThreadReadBusyError } from '../src/workers/connector-store/off-thread-reads.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';

const READ = 'internal.fake.notes';
const HELD = 'internal.fake.chats';
const ACCOUNT = 'personal';

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
