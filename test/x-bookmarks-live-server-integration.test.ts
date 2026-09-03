import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import { EmailClient, type EmailTransport } from '../src/core/email.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createXBookmarksConnectorStoreRuntime } from '../src/workers/email-source/server.ts';
import type { ConnectedCredentialHandle } from '../src/workers/credential-broker/connected-handles.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import {
  LocalXBookmarksApiUsageStore,
  X_BOOKMARKS_CORPUS_ID,
  createXBookmarksConnectorStore,
  createXBookmarksSourceConnector,
  type XApiUsageStatus,
  type XBookmarksConnectorStoreSyncHandler,
  type XBookmarksLiveSyncResult,
} from '../src/workers/x-bookmarks/index.ts';

describe('X bookmarks live server integration', () => {
  test('constructs the connector-store runtime only behind all three gates', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-x-live-server-'));
    const handle = xHandle();
    const embeddingProvider = fakeEmbeddingProvider();

    expect(createXBookmarksConnectorStoreRuntime({
      enabled: false,
      handle,
      embeddingProvider,
      dbPath: join(root, 'disabled.sqlite'),
    })).toBeUndefined();
    expect(createXBookmarksConnectorStoreRuntime({
      enabled: true,
      embeddingProvider,
      dbPath: join(root, 'missing-handle.sqlite'),
    })).toBeUndefined();
    expect(createXBookmarksConnectorStoreRuntime({
      enabled: true,
      handle,
      dbPath: join(root, 'missing-embedding.sqlite'),
    })).toBeUndefined();

    const usageStore = new LocalXBookmarksApiUsageStore(':memory:');
    const runtime = createXBookmarksConnectorStoreRuntime({
      enabled: true,
      handle,
      embeddingProvider,
      dbPath: join(root, 'x-shadow.sqlite'),
      usageStore,
      env: {},
    });
    expect(runtime?.store.corpusId).toBe(X_BOOKMARKS_CORPUS_ID);
    expect(runtime?.sync).toBeDefined();
    expect(runtime).not.toHaveProperty('legacyReplay');
    runtime?.store.close();
    usageStore.close();
  });

  test('runs explicit head, reconcile, and admin diagnostic modes through the live handler', async () => {
    const calls: string[] = [];
    const worker = createEmailSourceWorker({
      xBookmarksConnectorStoreSync: fakeLiveSync(calls),
    });

    const head = await postJson(worker, {
      corpus_id: X_BOOKMARKS_CORPUS_ID,
      mode: 'head',
    });
    expect(head).toMatchObject({
      mode: 'head',
      status: 'progress',
      counts: {
        api_requests: 2,
        items_seen: 1,
        items_indexed: 1,
        // The ladder a run climbed is receipt-visible: pages read, the size of
        // each page, and any deferred truncation suspicion.
        head_pages_read: 2,
        head_page_1_max_results: 10,
        head_page_2_max_results: 20,
        head_truncation_deferrals: 1,
      },
      warnings: ['x_head_truncation_suspected_deferred_checkpoint_preserved'],
      policy: {
        counts_only: true,
        source_text_returned: false,
        resource_ids_exposed: false,
        provider_cursor_exposed: false,
        sync_ids_exposed: false,
      },
    });
    expect(head.counts.checkpoint).toBeUndefined();
    expect(head.counts.head_page_51_max_results).toBeUndefined();
    expect(JSON.stringify(head)).not.toContain('provider-secret');

    const reconcile = await postJson(worker, {
      corpus_id: X_BOOKMARKS_CORPUS_ID,
      mode: 'reconcile',
    });
    expect(reconcile).toMatchObject({
      mode: 'reconcile',
      status: 'progress',
      counts: {
        folders_seen: 3,
        items_tombstoned: 1,
        reconcile_page_size_80_requests: 2,
        reconcile_page_size_50_requests: 1,
        reconcile_page_size_20_requests: 1,
        reconcile_page_size_other_requests: 0,
        reconcile_truncation_retries: 2,
      },
      warnings: [
        'x_reconcile_coverage_window_partial_no_absence_removals',
        'x_reconcile_truncation_suspected_smaller_page_retry',
      ],
    });
    expect(reconcile.counts.reconcile_page_size_10_requests).toBeUndefined();
    expect(JSON.stringify(reconcile)).not.toContain('provider-secret');
    const diagnostic = await postJson(worker, {
      corpus_id: X_BOOKMARKS_CORPUS_ID,
      mode: 'window_diagnostic',
    });
    expect(diagnostic).toMatchObject({
      mode: 'window_diagnostic',
      status: 'progress',
      counts: { diagnostic_probes: 4, diagnostic_requests: 7 },
      policy: {
        counts_only: true,
        source_text_returned: false,
        provider_cursor_exposed: false,
      },
    });
    expect(calls).toEqual(['head', 'reconcile', 'window_diagnostic']);
  }, 10_000);

  test('validates and dispatches X operator mode before the generic scheduler lane', async () => {
    const calls: string[] = [];
    const schedulerCalls: string[] = [];
    const worker = createEmailSourceWorker({
      xBookmarksConnectorStoreSync: fakeLiveSync(calls),
      sourceScheduler: {
        status: () => ({ sources: [{ source_id: 'x.bookmarks' }] }),
        runSource: async (sourceId: string) => {
          schedulerCalls.push(sourceId);
          return { kind: 'source_scheduler_run', status: 'idle' };
        },
      } as never,
    });

    const diagnostic = await postJson(worker, {
      corpus_id: X_BOOKMARKS_CORPUS_ID,
      mode: 'window_diagnostic',
    });
    expect(diagnostic.mode).toBe('window_diagnostic');
    expect(calls).toEqual(['window_diagnostic']);
    expect(schedulerCalls).toEqual([]);

    const invalid = await postJson(worker, {
      corpus_id: X_BOOKMARKS_CORPUS_ID,
      mode: 'garbage',
    }, 400);
    expect(invalid.error.code).toBe('invalid_request');
    expect(schedulerCalls).toEqual([]);
  });

  test('fails closed for live mode without the connector-store handler and preserves no-mode rollback', async () => {
    const unsupported = await postJson(createEmailSourceWorker(), {
      corpus_id: X_BOOKMARKS_CORPUS_ID,
      mode: 'head',
    }, 501);
    expect(unsupported.error.code).toBe('source_index_sync_not_supported');

    const noMode = await postJson(createEmailSourceWorker(), {
      corpus_id: X_BOOKMARKS_CORPUS_ID,
    }, 501);
    expect(noMode.error.code).toBe('source_index_sync_not_supported');
  });

  test('carries X mode through the operation and private EmailClient transport', async () => {
    const operation = operations.find((candidate) => candidate.name === 'source_index_sync')!;
    expect(operation.nativeExposure).toBe('emailIndexAdminDevOnly');
    expect(operation.params.mode).toMatchObject({
      enum: ['head', 'reconcile', 'window_diagnostic', 'folder_facet_refresh', 'preservation-reattest'],
    });
    const delegated: unknown[] = [];
    const context = {
      config: defaultConfig(),
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexSync: async (request: unknown) => {
          delegated.push(request);
          return { status: 'idle', counts: { api_requests: 1 } };
        },
      } as unknown as OperationContext['email'],
    } satisfies OperationContext;
    await operation.handler(context, {
      corpus_id: X_BOOKMARKS_CORPUS_ID,
      mode: 'head',
    });
    expect(delegated).toEqual([{ corpusId: X_BOOKMARKS_CORPUS_ID, mode: 'head' }]);
    await expect(operation.handler(context, {
      corpus_id: 'internal.drive.docs',
      mode: 'head',
    })).rejects.toThrow('mode is supported only for internal.x.bookmarks');

    const config = defaultConfig();
    config.email.enabled = true;
    config.email.indexAdminDevEnabled = true;
    let body: Record<string, unknown> | undefined;
    const transport: EmailTransport = {
      async requestJson(_url, init) {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return {
          mode: 'head',
          status: 'idle',
          counts: { api_requests: 1 },
          policy: {
            counts_only: true,
            raw_source_exposed: false,
            source_text_returned: false,
            resource_ids_exposed: false,
            provider_cursor_exposed: false,
            sync_ids_exposed: false,
          },
        };
      },
    };
    await new EmailClient(config, transport).sourceIndexSync({
      corpusId: X_BOOKMARKS_CORPUS_ID,
      mode: 'head',
    });
    expect(body).toEqual({ corpus_id: X_BOOKMARKS_CORPUS_ID, mode: 'head' });
  });

  test('connector-store read authority scopes direct search to the principal account and X embedding provider', async () => {
    const store = createXBookmarksConnectorStore(':memory:');
    const principal = 'owner@owner-example.test';
    const alias = 'alias-x';
    const postId = 'same-provider-post';
    const xEmbeddingCalls: string[] = [];
    const genericEmbeddingCalls: string[] = [];
    const xEmbedding = trackingEmbeddingProvider('x-specific-model', xEmbeddingCalls);
    const genericEmbedding = trackingEmbeddingProvider('generic-model', genericEmbeddingCalls);
    for (const account of [principal, alias]) {
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account,
        posts: [{ id: postId, text: `principal-scope-marker ${account}` }],
      }), { fetchContent: true });
    }
    await store.embedChunks({ provider: xEmbedding });
    xEmbeddingCalls.length = 0;

    const worker = createEmailSourceWorker({
      connectorStores: [store],
      connectorStoreEmbeddingProviders: new Map([[X_BOOKMARKS_CORPUS_ID, xEmbedding]]),
      connectorStoreAccountScopes: new Map([[X_BOOKMARKS_CORPUS_ID, principal]]),
      sourceIndexEmbeddingProvider: genericEmbedding,
    });
    const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        corpus_id: X_BOOKMARKS_CORPUS_ID,
        query: 'principal-scope-marker',
        retrieval_mode: 'hybrid',
      }),
    }));
    expect(response.status).toBe(200);
    const result = await response.json() as { hits: Array<{ sourceItem: { accountScope: string; providerItemId: string } }> };
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.sourceItem).toMatchObject({ accountScope: principal, providerItemId: postId });
    expect(new Set(result.hits.map((hit) => hit.sourceItem.providerItemId)).size).toBe(result.hits.length);
    expect(xEmbeddingCalls.length).toBeGreaterThan(0);
    expect(genericEmbeddingCalls).toEqual([]);
    store.close();
  });
});

function fakeLiveSync(calls: string[]): XBookmarksConnectorStoreSyncHandler {
  const usage = usageStatus();
  const result = (counts: Record<string, number>): XBookmarksLiveSyncResult => ({
    status: 'progress',
    counts: {
      ...counts,
      checkpoint: 'provider-secret',
    } as unknown as Record<string, number>,
    warnings: ['provider-secret'],
    api_usage: usage,
  });
  return {
    async syncHead() {
      calls.push('head');
      const response = result({
        api_requests: 2,
        items_seen: 1,
        items_indexed: 1,
        head_pages_read: 2,
        head_page_1_max_results: 10,
        head_page_2_max_results: 20,
        head_truncation_deferrals: 1,
        // Past the hard page cap, so the projection must drop it.
        head_page_51_max_results: 40,
      });
      response.warnings = [
        'x_head_truncation_suspected_deferred_checkpoint_preserved',
        'provider-secret',
      ];
      return response;
    },
    async reconcile() {
      calls.push('reconcile');
      const response = result({
        api_requests: 4,
        items_seen: 9,
        folders_seen: 3,
        items_tombstoned: 1,
        reconcile_page_size_80_requests: 2,
        reconcile_page_size_50_requests: 1,
        reconcile_page_size_20_requests: 1,
        reconcile_page_size_other_requests: 0,
        reconcile_truncation_retries: 2,
        // Out of the fixed ladder allowlist, so the projection must drop it.
        reconcile_page_size_10_requests: 9,
      });
      response.warnings = [
        'x_reconcile_coverage_window_partial_no_absence_removals',
        'x_reconcile_truncation_suspected_smaller_page_retry',
        'provider-secret',
      ];
      return response;
    },
    async diagnoseWindow() {
      calls.push('window_diagnostic');
      return result({ diagnostic_probes: 4, diagnostic_requests: 7 });
    },
    lastCompleteReconcileAt: () => undefined,
    completeReconcileWatermark: () => undefined,
    apiUsageStatus: () => usage,
  };
}

function usageStatus(): XApiUsageStatus {
  return {
    utc_day: '2026-07-18',
    api_requests: 7,
    resource_reads: 11,
    estimated_billable_resources: 11,
    reserved_resource_reads: 0,
    estimated_spend_microusd: 11_000,
    estimated_spend_usd: 0.011,
    estimated_unit_cost_usd: 0.001,
    estimate: true,
    hard_budgets: {
      api_requests: 4_000,
      resource_reads: 10_000,
      estimated_spend_microusd: 2_000_000,
    },
    guard: { state: 'ok' },
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      resource_ids_exposed: false,
      provider_cursor_exposed: false,
    },
  };
}

function xHandle(): ConnectedCredentialHandle {
  return {
    handle: 'x.bookmarks.personal',
    provider: 'x',
    accountRole: 'personal',
    providerAccountId: '42',
    allowedCapabilities: ['x.bookmarks.sync'],
    scopes: ['bookmark.read'],
    connectedAt: '2026-07-18T00:00:00.000Z',
  };
}

function fakeEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'test',
    modelId: 'test-embedding',
    dimension: 2,
    configHash: 'test-config',
    epochId: 'test-epoch',
    backend: 'cloud',
    async embed(inputs) {
      return inputs.map(() => [1, 0]);
    },
  };
}

function trackingEmbeddingProvider(modelId: string, calls: string[]): SourceEmbeddingProvider {
  return {
    provider: modelId,
    modelId,
    dimension: 2,
    configHash: `${modelId}-config`,
    epochId: `${modelId}-epoch`,
    backend: 'cloud',
    async embed(inputs) {
      calls.push(...inputs.map((input) => input.text));
      return inputs.map(() => [1, 0]);
    },
  };
}

async function postJson(
  worker: ReturnType<typeof createEmailSourceWorker>,
  body: Record<string, unknown>,
  expectedStatus = 200,
): Promise<Record<string, any>> {
  const response = await worker.fetch(new Request('http://worker.test/v1/source/index/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  expect(response.status).toBe(expectedStatus);
  return response.json() as Promise<Record<string, any>>;
}
