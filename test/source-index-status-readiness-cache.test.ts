import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { defineDropboxFilesCorpus } from '../src/workers/dropbox-files/index.ts';
import {
  DASHBOARD_READINESS_LEDGER_MAX_AGE_MS,
  createSourceIndexStatusHandler,
  resolveStatusRetrievalAvailability,
} from '../src/workers/source-index/status.ts';

const CORPUS_ID = 'secure_local.dropbox.files';
const ACCOUNT = 'dropbox.personal';

describe('connector-store status readiness', () => {
  test('reports a mounted empty store through the one canonical shape', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    try {
      const result = await createSourceIndexStatusHandler({
        corpusDefinitions: [defineDropboxFilesCorpus()],
        connectorStores: [store],
      }).status({ corpus_id: CORPUS_ID });

      expect(result.corpora).toEqual([expect.objectContaining({
        corpus_id: CORPUS_ID,
        configured: true,
        read_authority: 'connector_store',
        counts: {
          indexed_items: 0,
          tombstoned_items: 0,
          chunks: 0,
          embedded_chunks: 0,
          sync_runs: 0,
          items_with_text: 0,
        },
        item_metadata_returned: false,
        skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
      })]);
    } finally {
      store.close();
    }
  });

  test('publishes the per-item ready count, so a part-extracted corpus cannot read as fully ready', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    try {
      // Five files, one extracted. Its text chunks into several rows, which is
      // exactly the shape that let a chunk count stand in for item readiness.
      await store.syncFromConnector(connector([
        file('read.txt', 'paragraph of stored text. '.repeat(600)),
        file('unread-1.pdf'),
        file('unread-2.pdf'),
        file('unread-3.pdf'),
        file('unread-4.pdf'),
      ]), { fetchContent: true });

      const result = await createSourceIndexStatusHandler({
        corpusDefinitions: [defineDropboxFilesCorpus()],
        connectorStores: [store],
      }).status({ corpus_id: CORPUS_ID });

      const counts = (result.corpora[0] as { counts: Record<string, number> }).counts;
      expect(counts.indexed_items).toBe(5);
      expect(counts.items_with_text).toBe(1);
      expect(counts.chunks).toBeGreaterThan(1);
      // The per-item embedding gauge is a claim about the SERVING model, so
      // without a known model it is not published at all — the dashboard then
      // says "not measured" rather than counting some other model's vectors.
      expect('items_embedded' in counts).toBe(false);

      const withModel = await createSourceIndexStatusHandler({
        corpusDefinitions: [defineDropboxFilesCorpus()],
        connectorStores: [store],
        retrievalAvailability: { [CORPUS_ID]: { servable: true, modelId: 'fake-embed-v1' } },
      }).status({ corpus_id: CORPUS_ID });
      const modelCounts = (withModel.corpora[0] as { counts: Record<string, number> }).counts;
      // Known model, nothing embedded on it: zero files, zero chunks.
      expect(modelCounts.items_embedded).toBe(0);
      expect(modelCounts.embedded_chunks).toBe(0);
    } finally {
      store.close();
    }
  });

  test('returns readiness-ledger counts only when the caller asks for them', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    const asked: string[] = [];
    const handler = createSourceIndexStatusHandler({
      corpusDefinitions: [defineDropboxFilesCorpus()],
      connectorStores: [store],
      readinessLedger: {
        snapshotForCorpus(corpusId) {
          asked.push(corpusId);
          return { counts: {
              qa_metadata_only_expected: 60,
              qa_blocked_policy: 3,
              // A read authority's own fact, which the ledger must not be able to
              // overwrite: the store holds nothing, whatever this claims.
              indexed_items: 999_999,
            } };
        },
      },
    });
    try {
      const cheap = await handler.status({ corpus_id: CORPUS_ID });
      const cheapCounts = (cheap.corpora[0] as { counts: Record<string, number> }).counts;
      expect(asked).toEqual([]);
      expect(cheapCounts.qa_metadata_only_expected).toBeUndefined();

      const full = await handler.status({ corpus_id: CORPUS_ID, include_readiness_ledger: true });
      const fullCounts = (full.corpora[0] as { counts: Record<string, number> }).counts;
      expect(asked).toEqual([CORPUS_ID]);
      expect(fullCounts.qa_metadata_only_expected).toBe(60);
      expect(fullCounts.qa_blocked_policy).toBe(3);
      expect(fullCounts.indexed_items).toBe(0);
    } finally {
      store.close();
    }
  });

  test('publishes source-neutral extraction throughput beside readiness counts', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local',
    });
    let snapshotReads = 0;
    try {
      const result = await createSourceIndexStatusHandler({
        corpusDefinitions: [defineDropboxFilesCorpus()],
        connectorStores: [store],
        readinessLedger: {
          snapshotForCorpus: () => {
            snapshotReads += 1;
            return {
              counts: { extraction_jobs_queued_actionable: 4 },
              contentExtractionThroughput: {
                actionable_queued: 4,
                actionable_retryable_due: 1,
                oldest_actionable_at: '2026-09-01T00:00:00.000Z',
                newest_terminal_progress_at: '2026-09-01T01:00:00.000Z',
              },
            };
          },
        },
      }).status({ corpus_id: CORPUS_ID, include_readiness_ledger: true });
      expect(result.corpora[0]?.content_extraction_throughput).toEqual({
        actionable_queued: 4,
        actionable_retryable_due: 1,
        oldest_actionable_at: '2026-09-01T00:00:00.000Z',
        newest_terminal_progress_at: '2026-09-01T01:00:00.000Z',
      });
      expect(snapshotReads).toBe(1);
    } finally {
      store.close();
    }
  });

  test('honors the dashboard max-age allowance for the expensive full status snapshot', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local',
    });
    let nowMs = Date.parse('2026-09-01T12:00:00.000Z');
    let readinessReads = 0;
    const handler = createSourceIndexStatusHandler({
      corpusDefinitions: [defineDropboxFilesCorpus()],
      connectorStores: [store],
      nowMs: () => nowMs,
      readinessLedger: {
        snapshotForCorpus() {
          readinessReads += 1;
          return { counts: { qa_metadata_only_expected: 0 } };
        },
      },
    });
    try {
      await store.syncFromConnector(connector([file('one.txt', 'one')]), { fetchContent: true });
      const request = {
        corpus_id: CORPUS_ID,
        include_readiness_ledger: true,
        readiness_ledger_max_age_ms: DASHBOARD_READINESS_LEDGER_MAX_AGE_MS,
      };
      const first = await handler.status(request);
      expect((first.corpora[0] as { counts: Record<string, number> }).counts.indexed_items).toBe(1);
      await store.syncFromConnector(connector([file('one.txt', 'one'), file('two.txt', 'two')]), { fetchContent: true });
      const cached = await handler.status(request);
      expect((cached.corpora[0] as { counts: Record<string, number> }).counts.indexed_items).toBe(1);
      expect(readinessReads).toBe(1);

      nowMs += DASHBOARD_READINESS_LEDGER_MAX_AGE_MS + 1;
      const refreshed = await handler.status(request);
      expect((refreshed.corpora[0] as { counts: Record<string, number> }).counts.indexed_items).toBe(2);
      expect(readinessReads).toBe(2);
    } finally {
      store.close();
    }
  });

  test('a cached status never survives a change of serving model', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    // Mutable on purpose: the worker's availability object changes in place
    // when the embedding lane switches models, and the cache used to key on
    // the corpus alone — so model A's counts were served under model B for
    // the rest of the cache window.
    const availability: { servable: boolean; modelId?: string; embeddingEpoch?: string } = { servable: true, modelId: 'fake-embed-v1' };
    const nowMs = 1_700_000_000_000;
    const handler = createSourceIndexStatusHandler({
      corpusDefinitions: [defineDropboxFilesCorpus()],
      connectorStores: [store],
      nowMs: () => nowMs,
      retrievalAvailability: { [CORPUS_ID]: availability },
    });
    try {
      await store.syncFromConnector(connector([file('one.txt', 'one')]), { fetchContent: true });
      const request = {
        corpus_id: CORPUS_ID,
        include_readiness_ledger: true,
        readiness_ledger_max_age_ms: DASHBOARD_READINESS_LEDGER_MAX_AGE_MS,
      };
      const first = await handler.status(request);
      expect(first.corpora[0]?.retrieval?.model_id).toBe('fake-embed-v1');
      expect((first.corpora[0] as { counts: Record<string, number> }).counts.items_embedded).toBe(0);

      availability.modelId = 'fake-embed-v2';
      const switched = await handler.status(request);
      expect(switched.corpora[0]?.retrieval?.model_id).toBe('fake-embed-v2');
      expect((switched.corpora[0] as { counts: Record<string, number> }).counts.items_embedded).toBe(0);

      // An epoch change on the same model is a different serving identity too.
      availability.embeddingEpoch = 'epoch-2';
      const reEpoched = await handler.status(request);
      expect(reEpoched.corpora[0]?.retrieval?.embedding_epoch).toBe('epoch-2');

      // Free-form ids must not collide through the key: "m:a"+"b" is not
      // "m"+"a:b", whatever the key's own delimiter is.
      availability.modelId = 'm:a';
      availability.embeddingEpoch = 'b';
      const colliderA = await handler.status(request);
      availability.modelId = 'm';
      availability.embeddingEpoch = 'a:b';
      const colliderB = await handler.status(request);
      expect(colliderA.corpora[0]?.retrieval?.model_id).toBe('m:a');
      expect(colliderB.corpora[0]?.retrieval?.model_id).toBe('m');
      expect(colliderB.corpora[0]?.retrieval?.embedding_epoch).toBe('a:b');

      delete availability.embeddingEpoch;
      delete availability.modelId;
      const unknown = await handler.status(request);
      expect(unknown.corpora[0]?.retrieval?.model_id).toBeUndefined();
      expect('items_embedded' in (unknown.corpora[0] as { counts: Record<string, number> }).counts).toBe(false);
    } finally {
      store.close();
    }
  });

  test('refuses advertised legacy filters instead of returning unfiltered whole-corpus counts', async () => {
    const handler = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()] });
    await expect(handler.status({
      corpus_id: CORPUS_ID,
      approved_scope_key: 'dropbox.personal:/2 Areas',
    })).rejects.toThrow(/does not support.*approved_scope_key/);
  });

  test('reports an unmounted declared corpus as not configured', async () => {
    const result = await createSourceIndexStatusHandler({
      corpusDefinitions: [defineDropboxFilesCorpus()],
    }).status({ corpus_id: CORPUS_ID });

    expect(result.corpora).toEqual([expect.objectContaining({
      corpus_id: CORPUS_ID,
      configured: false,
      read_authority: 'connector_store',
      skipped_item_metadata_reason: 'source_index_not_configured',
    })]);
  });

  test('projects retrieval availability without consulting a legacy index cache', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    try {
      const result = await createSourceIndexStatusHandler({
        corpusDefinitions: [defineDropboxFilesCorpus()],
        connectorStores: [store],
        retrievalAvailability: {
          [CORPUS_ID]: {
            servable: false,
            reason: 'embedding_provider_unavailable',
          },
        },
      }).status({ corpus_id: CORPUS_ID });

      expect(result.corpora[0]?.retrieval).toMatchObject({
        state: 'degraded',
        servable_mode: 'keyword',
        reason: 'embedding_provider_unavailable',
      });
    } finally {
      store.close();
    }
  });

  test('fails closed when dynamic retrieval capability throws', () => {
    expect(resolveStatusRetrievalAvailability(() => {
      throw new Error('synthetic capability failure');
    }, {})).toEqual({
      servable: false,
      reason: 'hybrid_capability_unreported',
    });
    expect(DASHBOARD_READINESS_LEDGER_MAX_AGE_MS).toBe(120_000);
  });
});

function file(name: string, text?: string): RawItem {
  return {
    identity: {
      family: 'file',
      provider: 'dropbox',
      accountScope: ACCOUNT,
      providerItemId: name,
      localItemId: `${ACCOUNT}:${name}`,
      sourceVersion: 'rev-1',
    },
    mimeType: text === undefined ? 'application/pdf' : 'text/plain',
    content: text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text },
    metadata: { title: name },
    fetchedAt: '2026-08-31T12:00:00.000Z',
  };
}

function connector(items: RawItem[]): SourceConnector {
  return {
    id: 'dropbox-test',
    family: 'file',
    async authenticate() {},
    listItems() {
      return (async function* () {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string) {
      const found = items.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!found) throw new Error(`missing item ${localItemId}`);
      return found;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}
