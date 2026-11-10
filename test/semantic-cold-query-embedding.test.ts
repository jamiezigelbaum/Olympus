// A cold embedding model must not silently drop the meaning-based lane (#1172).
//
// The first question after an idle period reaches a local embedding model that
// is still starting, and its query embedding fails with a timeout. Search used
// to carry on with keyword results and an empty vector lane, and the evidence
// pack said nothing, so the answer looked complete when it had lost every
// meaning-based match. Now the shared path either waits for the model within a
// bounded budget (and the vector results arrive), or the pack's coverage says
// the meaning-based search was skipped.
//
// Synthetic data only. The provider is a fixture whose query embedding times
// out while it is "starting"; nothing here names a real source.

import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildEvidencePack } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import {
  TransientSourceEmbeddingError,
  type SourceEmbeddingInput,
  type SourceEmbeddingProvider,
  type SourceEmbeddingTaskType,
} from '../src/workers/source-index/embeddings.ts';
import { createTestClock, type TestClock } from './helpers/test-clock.ts';

const CORPUS = 'internal.fixture.notes';
const ACCOUNT = 'personal';

const NOTES = [
  { id: 'retro', text: 'Notes from the offsite retrospective about hiring.' },
  { id: 'plan', text: 'Quarterly planning document for next year.' },
] as const;

function rawItem(note: (typeof NOTES)[number]): RawItem {
  return {
    identity: {
      family: 'file', provider: 'fixture', accountScope: ACCOUNT,
      providerItemId: note.id, localItemId: `${ACCOUNT}:${note.id}`, sourceVersion: 'v1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: note.text },
    metadata: Object.freeze({ name: `${note.id}.txt` }),
    fetchedAt: '2026-09-01T00:00:00.000Z',
  };
}

function connector(): SourceConnector {
  return {
    id: 'fixture', family: 'file', async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* () { yield { items: NOTES.map(rawItem), done: true }; })();
    },
    async fetchItem(localItemId: string) {
      return rawItem(NOTES.find((note) => `${ACCOUNT}:${note.id}` === localItemId)!);
    },
    classificationSignals() { return {}; },
  };
}

// "strategy" shares no word with either note, so only the meaning-based lane
// can find the planning document: its vector points the same way.
function vectorFor(text: string): number[] {
  return /planning|strategy/i.test(text) ? [1, 0, 0] : [0, 1, 0];
}

interface ColdProvider extends SourceEmbeddingProvider {
  queryCalls(): number;
}

/**
 * A local model that is cold: its first query embedding times out while the
 * model starts. With `warmAfterMs` it finishes starting that long (on the test
 * clock) after the first call; without it, it never does.
 */
function coldProvider(clock: TestClock, warmAfterMs?: number): ColdProvider {
  let warm = false;
  let starting = false;
  let queryCalls = 0;
  return {
    provider: 'fixture', modelId: 'fixture-cold-model', dimension: 3, configHash: 'one',
    epochId: 'epoch:one', backend: 'local',
    queryCalls: () => queryCalls,
    async embed(inputs: SourceEmbeddingInput[], options: { taskType: SourceEmbeddingTaskType }) {
      if (options.taskType === 'RETRIEVAL_QUERY') {
        queryCalls += 1;
        if (!warm) {
          if (!starting && warmAfterMs !== undefined) {
            starting = true;
            clock.setTimeout(() => { warm = true; }, warmAfterMs);
          }
          throw new TransientSourceEmbeddingError('fixture', 'timeout', 0, 0, { modelStarting: true });
        }
      }
      return inputs.map((input) => vectorFor(input.text));
    },
  };
}

async function fixtureStore(): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS, family: 'file', trustDomain: 'internal' });
  await store.syncFromConnector(connector(), { fetchContent: true });
  // Documents were embedded earlier, while the model was warm.
  const warmDocuments: SourceEmbeddingProvider = {
    provider: 'fixture', modelId: 'fixture-cold-model', dimension: 3, configHash: 'one',
    epochId: 'epoch:one', backend: 'local',
    async embed(inputs) { return inputs.map((input) => vectorFor(input.text)); },
  };
  await store.embedChunks({ provider: warmDocuments });
  return store;
}

/** Runs the shared answer retrieval while moving the test clock until it settles. */
async function packWithClock(
  store: LocalConnectorStore,
  provider: SourceEmbeddingProvider,
  clock: TestClock,
): Promise<EvidencePack> {
  let settled = false;
  const pending = buildEvidencePack({
    question: 'What is our strategy?',
    searchQuery: 'strategy',
    maxResults: 5,
    searchContext: { allowedTrustDomains: ['internal'] },
    registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({
      corpusId: CORPUS, family: 'file', trustDomain: 'internal', activationMode: 'hybrid_primary',
    })]),
    adapters: {
      [CORPUS]: createConnectorStoreCorpusAdapter({
        store,
        embeddingProvider: provider,
        retrievalMode: 'hybrid',
        timers: clock,
      }),
    },
    contentProviders: { [CORPUS]: createConnectorStoreContentProvider({ store }) },
    // The store's own lane deadline is not under test here.
    laneTimeoutMs: 0,
  }).finally(() => { settled = true; });
  // A minute of fake time is far past any budget an answer could spend.
  for (let step = 0; step < 240 && !settled; step += 1) await clock.advance(250);
  expect(settled).toBe(true);
  return pending;
}

function meaningGaps(pack: EvidencePack): string[] {
  return pack.coverage.extractionGaps.filter((gap) => gap.includes(CORPUS) && /meaning-based search/i.test(gap));
}

describe('a cold embedding model on the first question (#1172)', () => {
  test('the search waits for the model to start within budget and the meaning-based match arrives', async () => {
    const clock = createTestClock();
    const store = await fixtureStore();
    const provider = coldProvider(clock, 5_000);

    const pack = await packWithClock(store, provider, clock);

    expect(pack.candidates.map((candidate) => candidate.provenance.sourceItem.localItemId))
      .toContain(`${ACCOUNT}:plan`);
    expect(meaningGaps(pack)).toEqual([]);
    expect(provider.queryCalls()).toBeGreaterThan(1);
  });

  test('a model that does not start within budget is reported in coverage, not dropped silently', async () => {
    const clock = createTestClock();
    const store = await fixtureStore();
    const provider = coldProvider(clock);

    const pack = await packWithClock(store, provider, clock);

    expect(pack.candidates.map((candidate) => candidate.provenance.sourceItem.localItemId))
      .not.toContain(`${ACCOUNT}:plan`);
    expect(meaningGaps(pack)).toHaveLength(1);
    // The provider was not hammered: the wait backs off.
    expect(provider.queryCalls()).toBeLessThan(40);
  });

  test('a cloud embedding provider is never waited for before the lanes run', async () => {
    // A cloud provider never reports a starting model; a stalled remote call
    // must not hold every corpus lane for the preparation budget.
    const store = await fixtureStore();
    const cloud: SourceEmbeddingProvider = {
      provider: 'fixture-cloud', modelId: 'fixture-cold-model', dimension: 3, configHash: 'one',
      epochId: 'epoch:one', backend: 'cloud',
      async embed(inputs) { return inputs.map((input) => vectorFor(input.text)); },
    };
    const local = coldProvider(createTestClock(), 5_000);
    const adapterFor = (embeddingProvider: SourceEmbeddingProvider) => createConnectorStoreCorpusAdapter({
      store, embeddingProvider, retrievalMode: 'hybrid',
    });

    expect(adapterFor(cloud).prepareSemantic).toBeUndefined();
    expect(adapterFor(local).prepareSemantic).toBeDefined();
  });

  test('a provider that is down, not starting, is not waited for', async () => {
    const clock = createTestClock();
    const store = await fixtureStore();
    let queryCalls = 0;
    const down: SourceEmbeddingProvider = {
      provider: 'fixture', modelId: 'fixture-cold-model', dimension: 3, configHash: 'one',
      epochId: 'epoch:one', backend: 'local',
      async embed(inputs, options) {
        if (options.taskType === 'RETRIEVAL_QUERY') {
          queryCalls += 1;
          throw new TransientSourceEmbeddingError('fixture', 503, 3, 30_000);
        }
        return inputs.map((input) => vectorFor(input.text));
      },
    };

    const startedAt = clock.now();
    const pack = await packWithClock(store, down, clock);

    expect(clock.now() - startedAt).toBeLessThan(1_000);
    expect(queryCalls).toBeLessThanOrEqual(2);
    expect(meaningGaps(pack)).toHaveLength(1);
  });
});
