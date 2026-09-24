// Owner decision, 2026-09-24 (embedding ledger entry
// decision-2026-09-24-readwise-hybrid): "Readwise: use existing embeddings for
// hybrid answers; decouple embedding from sync; keep vectors."
//
// The live failure it answers: the Readwise reconcile embedded every Private
// chunk inline through Venice, a 30 s Venice timeout failed the whole sync task
// after its items had already been committed, and the pull starved behind it.
// Meanwhile the stores were declared keyword-only, so the vectors it paid for
// never reached an answer.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { defaultConfig } from '../src/core/config.ts';
import { parseSensitivityMap, USER_FACING_TIER_MAPPING } from '../src/core/sensitivity-map.ts';
import { createSourceCorpusRegistry, defaultSourceCorpusRegistryConfig } from '../src/core/source-corpus-registry.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  embedQueuedChunks,
  syncAndEmbedFromConnector,
  type ConnectorStoreEmbeddingTarget,
} from '../src/workers/connector-store/index.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { buildEvidencePack } from '../src/core/evidence-pack.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  READWISE_LIBRARY_CORPUS_ID,
  ReadwiseDailyRequestBudget,
  createReadwiseConnectorStoreSyncHandler,
  defaultReadwiseLiveSyncConfig,
  defineReadwiseLibraryCorpus,
  type ReadwiseFetch,
} from '../src/workers/readwise/index.ts';
import { createReadwiseTierLane } from '../src/workers/readwise/tier-set.ts';
import {
  DeterministicSourceEmbeddingProvider,
  TransientSourceEmbeddingError,
  type SourceEmbeddingInput,
  type SourceEmbeddingTaskType,
} from '../src/workers/source-index/embeddings.ts';
import {
  SourceScheduler,
  createReadwiseSchedulerSource,
  withEmbeddingSweep,
  type SourceSchedulerSource,
} from '../src/workers/source-scheduler.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import { RecordingProvider } from './helpers/tier-fixtures.ts';

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-readwise-hybrid-'));
  roots.push(root);
  return root;
}

/** A provider that answers like Venice does when it is down: a 30 s budget timeout. */
class TimingOutProvider extends RecordingProvider {
  down = true;
  calls = 0;

  override async embed(inputs: SourceEmbeddingInput[]): Promise<number[][]> {
    this.calls += 1;
    if (this.down) throw new TransientSourceEmbeddingError('venice', 'timeout', 1, 30_000);
    return super.embed(inputs);
  }
}

function privateProvider(): TimingOutProvider {
  return new TimingOutProvider('openai-compatible', 'secure-local-qwen3-embed', 'local');
}

function cloudProvider(): RecordingProvider {
  return new RecordingProvider('google-gemini', 'gemini-embedding-2', 'cloud');
}

function readwiseItem(id: string, text: string): RawItem {
  return {
    identity: {
      family: 'readwise',
      provider: 'readwise',
      accountScope: 'personal',
      providerItemId: id,
      localItemId: `personal:${id}`,
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text },
    metadata: { title: id, name: id },
    fetchedAt: '2026-09-24T12:00:00.000Z',
  };
}

function listConnector(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'readwise_fixture',
    family: 'readwise',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* () {
        await Promise.resolve();
        yield { items: [...items], done: true };
      })();
    },
    async fetchItem(localItemId) {
      const item = items.find((entry) => entry.identity.localItemId === localItemId);
      if (!item) throw new Error('unknown fixture item');
      return item;
    },
    classificationSignals: () => ({}),
  } as SourceConnector;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** One Reader document and two highlights, one of them Private by the owner's map. */
function readwiseFetch(): ReadwiseFetch {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v3/list/') {
      return jsonResponse({
        count: 1,
        results: [{
          id: 'reader-1',
          title: 'Cities',
          summary: 'Maps change how cities imagine themselves.',
          updated_at: '2026-09-24T09:00:00.000Z',
        }],
      });
    }
    if (parsed.pathname === '/api/v2/export/') {
      return jsonResponse({
        results: [{
          user_book_id: 'book-42',
          title: 'Notes',
          highlights: [
            { id: 'hl-deal', text: 'Thoughts on the acme merger timeline.', updated_at: '2026-09-24T09:30:00.000Z' },
            { id: 'hl-city', text: 'A city is a machine for memory.', updated_at: '2026-09-24T09:31:00.000Z' },
          ],
        }],
      });
    }
    return jsonResponse({ error: 'unexpected URL' }, 404);
  };
}

function ownerMap() {
  return parseSensitivityMap({
    schemaVersion: 2,
    userFacingTiers: USER_FACING_TIER_MAPPING,
    categories: [{
      id: 'deal',
      label: 'deal',
      targetTierName: 'secure',
      targetTrustTier: USER_FACING_TIER_MAPPING.secure.targetTrustTier,
      targetTrustDomain: USER_FACING_TIER_MAPPING.secure.targetTrustDomain,
      examples: ['example'],
      match: { keywords: ['acme merger'], senderPatterns: [], pathPatterns: [] },
    }],
  });
}

describe('a provider timeout during sync never fails the sync (shared connector-store path)', () => {
  test('items commit, the embedding is deferred with a counts-only reason, and the chunks stay queued', async () => {
    const root = workspace();
    const store = new LocalConnectorStore({
      dbPath: join(root, 'store.sqlite'),
      corpusId: 'secure_local.fixture.library',
      family: 'readwise',
      trustDomain: 'secure_local',
    });
    closers.push(() => store.close());
    const provider = privateProvider();
    const connector = listConnector([
      readwiseItem('a', 'The first private highlight.'),
      readwiseItem('b', 'The second private highlight.'),
    ]);

    const run = await syncAndEmbedFromConnector({ store, connector, embeddingProvider: provider, sync: { fetchContent: true } });

    expect(run.sync.itemsIndexed).toBe(2);
    expect(run.embed.deferredReason).toBe('embedding_provider_unavailable:timeout');
    expect(store.status().counts).toMatchObject({ items: 2, chunks: 2, embeddedChunks: 0 });
    // Nothing is dropped: both items wait for the store's sweep, and the store
    // says its embedding is deferred.
    expect(store.queuedEmbeddingItemIds().sort()).toEqual(['personal:a', 'personal:b']);
    expect(store.embeddingDeferredReason()).toBe('embedding_provider_unavailable:timeout');

    // The provider comes back: the sweep embeds the queued chunks, once.
    provider.down = false;
    expect(await embedQueuedChunks([{ store, provider }])).toEqual([
      expect.objectContaining({ chunksEmbedded: 2 }),
    ]);
    expect(store.queuedEmbeddingItemIds()).toEqual([]);
    expect(store.embeddingDeferredReason()).toBeUndefined();
    expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(0);
    expect(store.status().counts).toMatchObject({ embeddedChunks: 2 });
  });

  test('a configuration fault still throws: only a provider outage is deferred', async () => {
    const root = workspace();
    const store = new LocalConnectorStore({
      dbPath: join(root, 'store.sqlite'),
      corpusId: 'secure_local.fixture.library',
      family: 'readwise',
      trustDomain: 'secure_local',
    });
    closers.push(() => store.close());
    const broken = privateProvider();
    broken.embed = async () => {
      throw new Error('Local source embedding model must be configured.');
    };

    await expect(syncAndEmbedFromConnector({
      store,
      connector: listConnector([readwiseItem('a', 'Text.')]),
      embeddingProvider: broken,
      sync: { fetchContent: true },
    })).rejects.toThrow('must be configured');
  });
});

describe('Readwise: sync commits, the embedding task embeds with backoff, nothing is re-embedded', () => {
  test('a Venice timeout leaves pull and reconcile successful, backs the embedding task off, then catches up', async () => {
    const root = workspace();
    const store = new LocalConnectorStore({
      dbPath: join(root, 'readwise.sqlite'),
      corpusId: READWISE_LIBRARY_CORPUS_ID,
      family: 'readwise',
      trustDomain: 'internal',
    });
    closers.push(() => store.close());
    const cloud = cloudProvider();
    const venice = privateProvider();
    const lane = createReadwiseTierLane({
      store,
      env: { OLYMPUS_SOURCE_INDEX_READWISE_SECURE_CONNECTOR_STORE_DB_PATH: join(root, 'readwise-secure.sqlite') },
      embeddingProvider: cloud,
      secureEmbeddingProvider: venice,
      tierClassification: { sensitivityMap: ownerMap() },
    });
    closers.push(() => lane.newStores.secure_local?.current()?.close());
    const clock = { now: new Date('2026-09-24T12:00:00.000Z') };
    const handler = createReadwiseConnectorStoreSyncHandler({
      store,
      embeddingProvider: cloud,
      tierSet: lane.set,
      account: 'personal',
      credentialBroker: new StaticCredentialBroker([{
        handle: 'readwise.personal',
        provider: 'readwise',
        allowedCapabilities: ['readwise.sync'],
        token: 'broker-token',
        scopes: ['readwise.reader:read', 'readwise.export:read'],
        trustDomain: 'internal',
      }]),
      fetch: readwiseFetch(),
      requestBudget: new ReadwiseDailyRequestBudget({ dailyRequestBudget: 50, now: () => clock.now }),
      now: () => clock.now,
    });
    const stateStore = new LocalSourceSchedulerStateStore(':memory:');
    closers.push(() => stateStore.close());
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 60_000,
      errorBackoffMs: 60_000,
      maxTransientRetries: 1,
      now: () => clock.now,
      stateStore,
      sources: withEmbeddingSweep([createReadwiseSchedulerSource({
        config: defaultConfig(),
        liveSync: handler,
        liveConfig: defaultReadwiseLiveSyncConfig({}),
      })!], () => () => {
        // The worker's registry: each mounted store with the identity it embeds with.
        const targets: ConnectorStoreEmbeddingTarget[] = [{ store, provider: cloud }];
        const secureStore = lane.newStores.secure_local?.current();
        if (secureStore) targets.push({ store: secureStore, provider: venice });
        return targets;
      }),
    });
    closers.push(() => scheduler.stop());
    const task = (id: string) => scheduler.status().sources[0]!.tasks.find((entry) => entry.id === id)!;

    await scheduler.runDueTasks();

    // Both syncs succeeded and committed every item, Private one included.
    for (const id of ['readwise.library_store_pull', 'readwise.library_store_reconcile']) {
      expect(task(id).consecutive_failures).toBe(0);
      expect(task(id).last_result?.status).not.toBe('failed');
    }
    const secure = lane.newStores.secure_local!.current()!;
    expect(store.status().counts.items).toBeGreaterThan(0);
    expect(secure.status().counts).toMatchObject({ items: 1, embeddedChunks: 0 });
    // The Personal store embedded on its own identity; the Private text never
    // reached the cloud identity.
    expect(store.status().counts.embeddedChunks).toBe(store.status().counts.chunks);
    expect(cloud.inputs.some((input) => input.includes('acme'))).toBe(false);

    // The embedding sweep did not fail: it deferred, said why, and doubled its
    // interval. It reports progress only for chunks it actually embedded.
    const deferred = task('readwise.library_embeddings');
    expect(deferred.kind).toBe('embed');
    expect(deferred.consecutive_failures).toBe(0);
    expect(deferred.last_result?.counts).toMatchObject({ stores_deferred: 1 });
    expect(deferred.degraded_reason).toBe('embedding_provider_unavailable');
    expect(deferred.effective_interval_seconds).toBe(120);

    // Venice stays down through the next due pass: the backoff doubles again,
    // and a sync that runs meanwhile says the store's embedding is deferred.
    clock.now = new Date(clock.now.getTime() + 15 * 60_000 + 1_000);
    await scheduler.runDueTasks();
    expect(task('readwise.library_embeddings').effective_interval_seconds).toBe(240);
    expect(task('readwise.library_embeddings').consecutive_failures).toBe(0);
    expect(task('readwise.library_store_pull').consecutive_failures).toBe(0);
    expect(task('readwise.library_store_pull').degraded_reason).toBe('embedding_provider_unavailable');

    // Venice comes back: the queued Private chunks embed, the interval and the
    // degraded reason reset, and the progress is real.
    venice.down = false;
    clock.now = new Date(clock.now.getTime() + 241_000);
    await scheduler.runDueTasks();
    const caughtUp = task('readwise.library_embeddings');
    expect(caughtUp.effective_interval_seconds).toBe(60);
    expect(caughtUp.degraded_reason).toBeUndefined();
    expect(caughtUp.last_result?.status).toBe('progress');
    expect(caughtUp.last_result?.counts).toMatchObject({ stores_deferred: 0 });
    expect(secure.status().counts.embeddedChunks).toBe(secure.status().counts.chunks);
    expect(venice.inputs.some((input) => input.includes('acme'))).toBe(true);

    // An idle sweep reports idle, not progress.
    clock.now = new Date(clock.now.getTime() + 61_000);
    await scheduler.runDueTasks();
    expect(task('readwise.library_embeddings').last_result?.status).toBe('idle');

    // No duplicate embeddings: another sync of the same items and another
    // sweep embed nothing that already has a vector at its content.
    const embeddedInputs = venice.inputs.length + cloud.inputs.length;
    await handler.pull();
    await embedQueuedChunks([{ store, provider: cloud }, { store: secure, provider: venice }]);
    expect(venice.inputs.length + cloud.inputs.length).toBe(embeddedInputs);
  });

  test('the pull and reconcile never call an embedding provider', async () => {
    const root = workspace();
    const store = new LocalConnectorStore({
      dbPath: join(root, 'readwise.sqlite'),
      corpusId: READWISE_LIBRARY_CORPUS_ID,
      family: 'readwise',
      trustDomain: 'internal',
    });
    closers.push(() => store.close());
    const cloud = cloudProvider();
    const venice = privateProvider();
    const lane = createReadwiseTierLane({
      store,
      env: { OLYMPUS_SOURCE_INDEX_READWISE_SECURE_CONNECTOR_STORE_DB_PATH: join(root, 'readwise-secure.sqlite') },
      embeddingProvider: cloud,
      secureEmbeddingProvider: venice,
      tierClassification: { sensitivityMap: ownerMap() },
    });
    closers.push(() => lane.newStores.secure_local?.current()?.close());
    const now = () => new Date('2026-09-24T12:00:00.000Z');
    const handler = createReadwiseConnectorStoreSyncHandler({
      store,
      embeddingProvider: cloud,
      tierSet: lane.set,
      account: 'personal',
      credentialBroker: new StaticCredentialBroker([{
        handle: 'readwise.personal',
        provider: 'readwise',
        allowedCapabilities: ['readwise.sync'],
        token: 'broker-token',
        scopes: ['readwise.reader:read', 'readwise.export:read'],
        trustDomain: 'internal',
      }]),
      fetch: readwiseFetch(),
      requestBudget: new ReadwiseDailyRequestBudget({ dailyRequestBudget: 50, now }),
      now,
    });

    await handler.pull();
    await handler.reconcile();

    expect(cloud.inputs).toEqual([]);
    expect(venice.calls).toBe(0);
    expect(store.status().counts.embeddedChunks).toBe(0);
  });
});

describe('Readwise answers are hybrid in both tiers', () => {
  test('both Readwise corpora declare hybrid_primary', () => {
    const registry = createSourceCorpusRegistry(defaultSourceCorpusRegistryConfig());
    const modes = Object.fromEntries(registry.definitions().map((definition) => [definition.corpusId, definition.activationMode]));

    expect(defineReadwiseLibraryCorpus().activationMode).toBe('hybrid_primary');
    expect(modes['internal.readwise.library']).toBe('hybrid_primary');
    expect(modes['secure_local.readwise.library']).toBe('hybrid_primary');
  });

  test('a Readwise answer lane returns a vector hit a keyword search cannot find', async () => {
    const root = workspace();
    const store = new LocalConnectorStore({
      dbPath: join(root, 'readwise.sqlite'),
      corpusId: READWISE_LIBRARY_CORPUS_ID,
      family: 'readwise',
      trustDomain: 'internal',
    });
    closers.push(() => store.close());
    const provider = new DeterministicSourceEmbeddingProvider({
      modelId: 'readwise-hybrid-test',
      conceptGroups: [['equanimity', 'stoicism', 'stoic']],
    });
    await store.syncFromConnector(listConnector([
      readwiseItem('hl-stoic', 'Marcus Aurelius on stoicism and the discipline of assent.'),
      readwiseItem('hl-city', 'A city is a machine for memory.'),
    ]), { fetchContent: true });
    await store.embedChunks({ provider });
    const request = {
      query: 'equanimity',
      maxResults: 5,
      corpus: defineReadwiseLibraryCorpus(),
      context: { allowedTrustDomains: ['internal' as const] },
    };

    const keyword = await createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword' })(request);
    const hybrid = await createConnectorStoreCorpusAdapter({ store, embeddingProvider: provider, retrievalMode: 'hybrid' })(request);

    expect(keyword.hits.map((hit) => hit.sourceItem.providerItemId)).not.toContain('hl-stoic');
    expect(hybrid.hits.map((hit) => hit.sourceItem.providerItemId)).toContain('hl-stoic');
    expect((hybrid.laneAudits ?? []).map((audit) => audit.laneType)).toEqual(
      expect.arrayContaining([expect.stringMatching(/semantic|hybrid/)]),
    );
  });
});

describe('the generic embedding sweep recovers any lane that deferred inline (chat lanes, tier legs)', () => {
  test('a chat-style lane that embeds inline: the sync succeeds degraded, the sweep catches up, the degraded reason clears', async () => {
    const root = workspace();
    const store = new LocalConnectorStore({
      dbPath: join(root, 'chat.sqlite'),
      corpusId: 'secure_local.fixture.messages',
      family: 'readwise',
      trustDomain: 'secure_local',
    });
    closers.push(() => store.close());
    const provider = privateProvider();
    const items = [readwiseItem('m1', 'First message.'), readwiseItem('m2', 'Second message.')];
    const source: SourceSchedulerSource = {
      sourceId: 'fixture.messages',
      corpusId: store.corpusId,
      cadence: 'continuous',
      intervalMs: 5 * 60_000,
      freshnessThresholdHours: 26,
      tasks: [{
        id: 'fixture.messages_store_pull',
        kind: 'sync',
        writer: true,
        run: async () => {
          const run = await syncAndEmbedFromConnector({
            store, connector: listConnector(items), embeddingProvider: provider, sync: { fetchContent: true },
          });
          return { status: 'progress', counts: { items_indexed: run.sync.itemsIndexed } };
        },
      }],
    };
    const clock = { now: new Date('2026-09-24T12:00:00.000Z') };
    const stateStore = new LocalSourceSchedulerStateStore(':memory:');
    closers.push(() => stateStore.close());
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 60_000,
      errorBackoffMs: 60_000,
      maxTransientRetries: 1,
      now: () => clock.now,
      stateStore,
      sources: withEmbeddingSweep([source], () => () => [{ store, provider }]),
    });
    closers.push(() => scheduler.stop());
    const task = (id: string) => scheduler.status().sources[0]!.tasks.find((entry) => entry.id === id)!;

    await scheduler.runDueTasks();
    expect(task('fixture.messages_store_pull').consecutive_failures).toBe(0);
    expect(task('fixture.messages_store_pull').degraded_reason).toBe('embedding_provider_unavailable');
    expect(task('fixture.messages_embeddings').degraded_reason).toBe('embedding_provider_unavailable');
    expect(store.queuedEmbeddingItemIds()).toHaveLength(2);

    provider.down = false;
    clock.now = new Date(clock.now.getTime() + 121_000);
    await scheduler.runDueTasks();
    expect(store.status().counts).toMatchObject({ chunks: 2, embeddedChunks: 2 });
    expect(task('fixture.messages_embeddings').degraded_reason).toBeUndefined();

    clock.now = new Date(clock.now.getTime() + 5 * 60_000 + 1_000);
    await scheduler.runDueTasks();
    expect(task('fixture.messages_store_pull').degraded_reason).toBeUndefined();
  });

  test('a source that declares its own embed task keeps it and gets no second sweep', () => {
    const store = { embeddingDeferredReason: () => undefined, queuedEmbeddingItemIds: () => [] };
    const source: SourceSchedulerSource = {
      sourceId: 'dropbox.files',
      corpusId: 'secure_local.dropbox.files',
      cadence: 'continuous',
      intervalMs: 60_000,
      freshnessThresholdHours: 26,
      tasks: [{ id: 'dropbox.files_embeddings', kind: 'embed', writer: true, run: async () => ({ status: 'idle' }) }],
    };
    const [swept] = withEmbeddingSweep([source], () => () => [{ store, provider: cloudProvider() } as never]);
    expect(swept!.tasks.map((entry) => entry.id)).toEqual(['dropbox.files_embeddings']);
  });
});

describe('one embedder per store', () => {
  test('two embedders on the same store never embed the same chunk twice', async () => {
    const root = workspace();
    const store = new LocalConnectorStore({
      dbPath: join(root, 'shared.sqlite'),
      corpusId: 'internal.fixture.library',
      family: 'readwise',
      trustDomain: 'internal',
    });
    closers.push(() => store.close());
    await store.syncFromConnector(listConnector([
      readwiseItem('a', 'Alpha text.'),
      readwiseItem('b', 'Beta text.'),
      readwiseItem('c', 'Gamma text.'),
    ]), { fetchContent: true });
    const slow = cloudProvider();
    const original = slow.embed.bind(slow);
    slow.embed = async (inputs) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return original(inputs);
    };

    // The drain's call and the scheduler's sweep, at once, on one store.
    const [first, second] = await Promise.all([
      store.embedChunks({ provider: slow }),
      store.embedChunks({ provider: slow }),
    ]);

    expect(first.chunksEmbedded + second.chunksEmbedded).toBe(3);
    expect(slow.inputs).toHaveLength(3);
  });
});

/** A Venice-shaped private identity: approved for Private stores, semantic like the deterministic provider. */
class VenicePrivateProvider extends DeterministicSourceEmbeddingProvider {
  override provider = 'venice';
  override backend = 'cloud' as unknown as 'local';
  readonly taskTypes: SourceEmbeddingTaskType[] = [];

  override async embed(inputs: SourceEmbeddingInput[], options: { taskType: SourceEmbeddingTaskType }): Promise<number[][]> {
    this.taskTypes.push(options.taskType);
    return super.embed(inputs, options);
  }
}

class RecordingCloudProvider extends DeterministicSourceEmbeddingProvider {
  override provider = 'google-gemini';
  override backend = 'cloud' as unknown as 'local';
  calls = 0;

  override async embed(inputs: SourceEmbeddingInput[], options: { taskType: SourceEmbeddingTaskType }): Promise<number[][]> {
    this.calls += 1;
    return super.embed(inputs, options);
  }
}

describe('Readwise Private (readwise-secure) answers hybrid end to end', () => {
  test('Venice embeds the query, a cloud identity is refused, and a vector-only hit reaches the evidence', async () => {
    const root = workspace();
    const secure = new LocalConnectorStore({
      dbPath: join(root, 'readwise-secure.sqlite'),
      corpusId: 'secure_local.readwise.library',
      family: 'readwise',
      trustDomain: 'secure_local',
    });
    closers.push(() => secure.close());
    const conceptGroups = [['equanimity', 'stoicism', 'stoic']];
    const venice = new VenicePrivateProvider({ modelId: 'venice-private-embed', conceptGroups });
    const cloud = new RecordingCloudProvider({ modelId: 'gemini-embedding-2', conceptGroups });
    await secure.syncFromConnector(listConnector([
      readwiseItem('hl-stoic', 'My therapist said stoicism helps with the diagnosis.'),
      readwiseItem('hl-city', 'A city is a machine for memory.'),
    ]), { fetchContent: true });
    await secure.embedChunks({ provider: venice });
    venice.taskTypes.length = 0;

    const definitions = createSourceCorpusRegistry(defaultSourceCorpusRegistryConfig()).definitions();
    const secureDefinition = definitions.find((definition) => definition.corpusId === 'secure_local.readwise.library')!;
    expect(secureDefinition.activationMode).toBe('hybrid_primary');
    const registry = buildSourceIndexCorpusRegistry([secureDefinition]);
    const evidence = (provider: VenicePrivateProvider | RecordingCloudProvider) => buildEvidencePack({
      question: 'What did I note about equanimity?',
      searchQuery: 'equanimity',
      maxResults: 5,
      searchContext: { allowedTrustDomains: ['secure_local'] },
      registry,
      adapters: {
        [secure.corpusId]: createConnectorStoreCorpusAdapter({ store: secure, embeddingProvider: provider, retrievalMode: 'hybrid' }),
      },
      contentProviders: { [secure.corpusId]: createConnectorStoreContentProvider({ store: secure }) },
    });

    // Venice: the query is embedded on the private identity and the
    // vector-only hit (no keyword overlap) is in the evidence.
    const privatePack = await evidence(venice);
    expect(venice.taskTypes).toContain('RETRIEVAL_QUERY');
    expect(privatePack.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId)).toContain('hl-stoic');

    // A cloud identity is refused for the Private store: it never embeds the
    // query, and no vector hit comes back.
    const cloudPack = await evidence(cloud);
    expect(cloud.calls).toBe(0);
    expect(cloudPack.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId)).not.toContain('hl-stoic');
  });
});
