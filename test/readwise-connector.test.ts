import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  createConnectorStoreCorpusAdapter,
} from '../src/workers/connector-store/index.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  READWISE_LIBRARY_CORPUS_ID,
  ReadwiseDailyRequestBudget,
  ReadwiseRequestBudgetError,
  createReadwiseConnectorStore,
  createReadwiseConnectorStoreSyncHandler,
  createReadwiseSourceConnector,
  readwiseDailyRequestBudgetFromEnv,
  type ReadwiseFetch,
} from '../src/workers/readwise/index.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  createReadwiseConnectorStoreRuntime,
} from '../src/workers/email-source/server.ts';
import { DeterministicSourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'person@example.com';
const NOW = new Date('2026-07-26T10:00:00.000Z');

describe('Readwise thin connector and canonical store', () => {
  test('paginates Reader documents and exported highlights with stable document-scoped identity', async () => {
    const calls: string[] = [];
    const authorizations: string[] = [];
    const connector = createReadwiseSourceConnector({
      account: ACCOUNT,
      credentialBroker: readwiseBroker(),
      pageSize: 2,
      now: () => NOW,
      fetch: paginatedReadwiseFetch(calls, authorizations),
      requestBudget: new ReadwiseDailyRequestBudget({
        dailyRequestBudget: 10,
        now: () => NOW,
      }),
    });

    const pages = [];
    for await (const page of connector.listItems()) pages.push(page);
    const items = pages.flatMap((page) => [...page.items]);

    expect(calls).toEqual([
      'https://readwise.io/api/v3/list/?limit=2&withHtmlContent=true&withRawSourceUrl=true',
      'https://readwise.io/api/v3/list/?limit=2&pageCursor=reader-cursor-2&withHtmlContent=true&withRawSourceUrl=true',
      'https://readwise.io/api/v2/export/',
      'https://readwise.io/api/v2/export/?pageCursor=export-cursor-2',
    ]);
    expect(authorizations).toEqual([
      'Token broker-token',
      'Token broker-token',
      'Token broker-token',
      'Token broker-token',
    ]);
    expect(pages.at(-1)?.done).toBe(true);
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({
      identity: {
        family: 'readwise',
        provider: 'readwise',
        accountScope: ACCOUNT,
        providerItemId: 'reader-1',
        providerThreadId: 'document:reader-1',
        providerConversationId: 'document:reader-1',
        localItemId: `${ACCOUNT}:document:reader-1`,
      },
      content: {
        kind: 'text',
        text: 'Reader one private marker',
      },
    });
    const highlight = items.find((item) => item.identity.providerItemId === 'highlight-7');
    expect(highlight).toMatchObject({
      identity: {
        providerItemId: 'highlight-7',
        providerThreadId: 'document:book-42',
        providerConversationId: 'document:book-42',
        localItemId: `${ACCOUNT}:highlight:highlight-7`,
      },
      content: {
        kind: 'text',
        text: 'Highlight seven private marker',
      },
      metadata: {
        itemKind: 'highlight',
        documentId: 'book-42',
      },
    });
    expect(connector.classify(highlight!)).toMatchObject({
      trustTier: 'S1',
      trustDomain: 'internal',
      localOnly: false,
    });
    expect(await connector.fetchItem(highlight!.identity.localItemId)).toBe(highlight!);
    expect(connector.requestBudgetStatus()).toEqual({
      utcDay: '2026-07-26',
      requests: 4,
      dailyRequestBudget: 10,
    });
  });

  test('a bounded run never reports a truncated export page as done, and resumes inside it', async () => {
    const firstCalls: string[] = [];
    const first = await collectPages(
      truncatedExportConnector(firstCalls),
      { limit: 3 },
    );
    const cut = first.at(-1)!;

    // The page the provider sent held five highlights; the run could only
    // take three. Reporting `done` here is what cleared the checkpoint and
    // restarted every later pull at reader page 1.
    expect(cut.items.map(itemId)).toEqual(['highlight-1', 'highlight-2', 'highlight-3']);
    expect(cut.done).toBe(false);
    expect(cut.truncated).toBe(true);
    expect(cut.nextCursor).toBeDefined();

    const secondCalls: string[] = [];
    const second = await collectPages(
      truncatedExportConnector(secondCalls),
      { cursor: cut.nextCursor, limit: 10 },
    );
    // The tail, and only the tail: the resume re-reads the same provider page
    // and drops what was already stored. It also skips the reader phase, so
    // the run costs exactly one request.
    expect(second.flatMap((page) => page.items.map(itemId))).toEqual(['highlight-4', 'highlight-5']);
    expect(second.at(-1)?.done).toBe(true);
    expect(secondCalls).toEqual(['/api/v2/export/']);
  });

  test('a completed sweep publishes its watermark so the next sweep is incremental', async () => {
    const sweep = await collectPages(truncatedExportConnector([]), { limit: 50 });
    const finished = sweep.at(-1)!;
    expect(finished.done).toBe(true);

    const nextSweepCalls: string[] = [];
    await collectPages(
      truncatedExportConnector(nextSweepCalls),
      { cursor: finished.nextCursor, limit: 50 },
    );
    // Highest updated_at in the sweep was 2026-07-25. The next sweep asks the
    // provider for changes since then instead of re-walking the library.
    expect(nextSweepCalls).toEqual([
      '/api/v3/list/?limit=2&updatedAfter=2026-07-25T09%3A00%3A00.000Z&withHtmlContent=true&withRawSourceUrl=true',
      '/api/v2/export/?updatedAfter=2026-07-25T09%3A00%3A00.000Z',
    ]);
  });

  test('refuses provider I/O before exceeding the validated daily request budget', async () => {
    const calls: string[] = [];
    const connector = createReadwiseSourceConnector({
      credentialBroker: readwiseBroker(),
      pageSize: 1,
      now: () => NOW,
      requestBudget: new ReadwiseDailyRequestBudget({
        dailyRequestBudget: 1,
        now: () => NOW,
      }),
      fetch: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({
          count: 1,
          nextPageCursor: 'reader-cursor-2',
          results: [{ id: 'reader-1', summary: 'bounded marker' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    await expect(async () => {
      for await (const _page of connector.listItems()) {
        // Exhaust traversal so the second provider request reaches the guard.
      }
    }).toThrow(ReadwiseRequestBudgetError);
    expect(calls).toHaveLength(1);
    expect(connector.requestBudgetStatus().requests).toBe(1);
    expect(() => readwiseDailyRequestBudgetFromEnv({
      OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET: '1.5',
    })).toThrow(
      'OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET must be a positive integer.',
    );
  });

  test('syncs into the shared store idempotently and remains inert behind legacy read authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-readwise-connector-'));
    const store = createReadwiseConnectorStore(join(root, 'readwise-connector.sqlite'));
    const provider = new DeterministicSourceEmbeddingProvider({
      modelId: 'readwise-dark-test',
      epochId: 'cloud:test:readwise-dark-test:v1',
    });
    const requestBudget = new ReadwiseDailyRequestBudget({
      dailyRequestBudget: 20,
      now: () => NOW,
    });
    const sync = createReadwiseConnectorStoreSyncHandler({
      store,
      embeddingProvider: provider,
      account: ACCOUNT,
      credentialBroker: readwiseBroker(),
      fetch: singlePageReadwiseFetch(),
      requestBudget,
      now: () => NOW,
    });

    try {
      const first = await sync.sync();
      const firstStatus = store.status();
      const second = await sync.sync();
      const secondStatus = store.status();

      expect(first).toMatchObject({
        status: 'progress',
        counts: {
          api_requests: 2,
          daily_api_request_budget: 20,
          items_seen: 2,
          items_indexed: 2,
          items_tombstoned: 0,
          chunks_indexed: 2,
          chunks_embedded: 2,
        },
        policy: {
          counts_only: true,
          raw_source_exposed: false,
          source_text_returned: false,
          provider_cursor_exposed: false,
        },
      });
      expect(firstStatus.counts).toMatchObject({
        items: 2,
        chunks: 2,
        embeddedChunks: 2,
        syncRuns: 1,
      });
      expect(second.counts).toMatchObject({
        api_requests: 4,
        items_seen: 2,
        items_indexed: 2,
        chunks_embedded: 0,
      });
      expect(secondStatus.counts).toMatchObject({
        items: 2,
        chunks: 2,
        embeddedChunks: 2,
        syncRuns: 2,
      });
      expect(JSON.stringify([first, second])).not.toContain('PRIVATE_READWISE_MARKER');

      const connectorAdapter = createConnectorStoreCorpusAdapter({ store });
      expect(connectorAdapter).toBeDefined();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses the canonical counts-only admin route with or without an explicit mode', async () => {
    const store = createReadwiseConnectorStore(':memory:');
    const sync = createReadwiseConnectorStoreSyncHandler({
      store,
      embeddingProvider: new DeterministicSourceEmbeddingProvider({
        modelId: 'readwise-admin-test',
      }),
      credentialBroker: readwiseBroker(),
      fetch: singlePageReadwiseFetch(),
      requestBudget: new ReadwiseDailyRequestBudget({
        dailyRequestBudget: 20,
        now: () => NOW,
      }),
      now: () => NOW,
    });
    const worker = createEmailSourceWorker({ readwiseConnectorStoreSync: sync });
    try {
      const response = await worker.fetch(new Request('http://worker.test/v1/source/index/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          corpus_id: READWISE_LIBRARY_CORPUS_ID,
          mode: 'connector_store',
        }),
      }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: 'progress',
        counts: {
          api_requests: 2,
          items_seen: 2,
          chunks_embedded: 2,
        },
        policy: {
          counts_only: true,
          raw_source_exposed: false,
          source_text_returned: false,
        },
      });
      expect(JSON.stringify(body)).not.toContain('PRIVATE_READWISE_MARKER');

      const canonicalDefault = await worker.fetch(new Request('http://worker.test/v1/source/index/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ corpus_id: READWISE_LIBRARY_CORPUS_ID }),
      }));
      expect(canonicalDefault.status).toBe(200);
      expect(await canonicalDefault.json()).toMatchObject({
        policy: { counts_only: true, raw_source_exposed: false },
      });
    } finally {
      store.close();
    }
  });

  test('constructs and mounts the store only when its activation gate is true', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-readwise-runtime-'));
    const dbPath = join(root, 'readwise-dark.sqlite');
    const embeddingProvider = new DeterministicSourceEmbeddingProvider();
    try {
      expect(createReadwiseConnectorStoreRuntime({
        enabled: false,
        embeddingProvider,
        dbPath,
        env: {
          OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET: 'invalid-but-inert',
        },
      })).toBeUndefined();
      expect(existsSync(dbPath)).toBe(false);
      expect(() => createReadwiseConnectorStoreRuntime({
        enabled: true,
        embeddingProvider,
        dbPath,
        env: {
          OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET: 'invalid',
        },
      })).toThrow(
        'OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET must be a positive integer.',
      );
      expect(existsSync(dbPath)).toBe(false);

      const runtime = createReadwiseConnectorStoreRuntime({
        enabled: true,
        embeddingProvider,
        dbPath,
        env: {
          OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET: '50',
        },
      });
      expect(runtime?.store).toMatchObject({
        corpusId: READWISE_LIBRARY_CORPUS_ID,
        family: 'readwise',
        trustDomain: 'internal',
      });
      expect(existsSync(dbPath)).toBe(true);
      runtime?.store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function readwiseBroker(): StaticCredentialBroker {
  return new StaticCredentialBroker([{
    handle: 'readwise.personal',
    provider: 'readwise',
    allowedCapabilities: ['readwise.sync'],
    token: 'broker-token',
    scopes: ['readwise.reader:read', 'readwise.export:read'],
    trustDomain: 'internal',
  }]);
}

function paginatedReadwiseFetch(
  calls: string[],
  authorizations: string[],
): ReadwiseFetch {
  return async (url, init) => {
    calls.push(url);
    authorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v3/list/' && !parsed.searchParams.has('pageCursor')) {
      return jsonResponse({
        count: 2,
        nextPageCursor: 'reader-cursor-2',
        results: [
          { id: 'reader-1', title: 'Reader one', summary: 'Reader one private marker' },
          { id: 'reader-2', title: 'Reader two', summary: 'Reader two private marker' },
        ],
      });
    }
    if (parsed.pathname === '/api/v3/list/') {
      return jsonResponse({
        count: 1,
        results: [
          { id: 'reader-3', title: 'Reader three', summary: 'Reader three private marker' },
        ],
      });
    }
    if (parsed.pathname === '/api/v2/export/' && !parsed.searchParams.has('pageCursor')) {
      return jsonResponse({
        nextPageCursor: 'export-cursor-2',
        results: [{
          user_book_id: 'book-42',
          title: 'Book 42',
          highlights: [{
            id: 'highlight-7',
            text: 'Highlight seven private marker',
            updated_at: '2026-07-25T09:00:00.000Z',
          }],
        }],
      });
    }
    if (parsed.pathname === '/api/v2/export/') {
      return jsonResponse({
        results: [{
          user_book_id: 'book-99',
          title: 'Book 99',
          highlights: [{
            id: 'highlight-8',
            text: 'Highlight eight private marker',
          }],
        }],
      });
    }
    return jsonResponse({ error: 'unexpected URL' }, 404);
  };
}

function singlePageReadwiseFetch(): ReadwiseFetch {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v3/list/') {
      return jsonResponse({
        count: 1,
        results: [{
          id: 'reader-1',
          title: 'Private document',
          summary: 'PRIVATE_READWISE_MARKER document content',
          updated_at: '2026-07-25T09:00:00.000Z',
        }],
      });
    }
    if (parsed.pathname === '/api/v2/export/') {
      return jsonResponse({
        results: [{
          user_book_id: 'book-42',
          title: 'Private book',
          highlights: [{
            id: 'highlight-7',
            text: 'PRIVATE_READWISE_MARKER highlight content',
            updated_at: '2026-07-25T09:30:00.000Z',
          }],
        }],
      });
    }
    return jsonResponse({ error: 'unexpected URL' }, 404);
  };
}

function itemId(item: { identity: { providerItemId: string } }): string {
  return item.identity.providerItemId;
}

async function collectPages(
  connector: ReturnType<typeof createReadwiseSourceConnector>,
  options: { cursor?: string | undefined; limit?: number },
): Promise<Array<{
  items: readonly { identity: { providerItemId: string } }[];
  nextCursor?: string;
  done: boolean;
  truncated?: boolean;
}>> {
  const pages = [];
  const listOptions = {
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  };
  for await (const page of connector.listItems(listOptions)) pages.push(page);
  return pages;
}

/**
 * One export page holding more highlights than a bounded run can take, served
 * as a bare JSON array — the shape the live endpoint actually returns, with no
 * provider cursor anywhere in it.
 */
function truncatedExportConnector(calls: string[]) {
  return createReadwiseSourceConnector({
    account: ACCOUNT,
    credentialBroker: readwiseBroker(),
    pageSize: 2,
    now: () => NOW,
    fetch: async (url) => {
      const parsed = new URL(url);
      calls.push(`${parsed.pathname}${parsed.search}`);
      if (parsed.pathname === '/api/v3/list/') return jsonResponse({ count: 0, results: [] });
      if (parsed.pathname === '/api/v2/export/') {
        return jsonResponse([{
          user_book_id: 'book-1',
          title: 'Book one',
          highlights: [1, 2, 3, 4, 5].map((n) => ({
            id: `highlight-${n}`,
            text: `Highlight ${n} private marker`,
            updated_at: `2026-07-2${n}T09:00:00.000Z`,
          })),
        }]);
      }
      return jsonResponse({ error: 'unexpected URL' }, 404);
    },
    requestBudget: new ReadwiseDailyRequestBudget({ dailyRequestBudget: 50, now: () => NOW }),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
