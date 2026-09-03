import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  XApiClient,
  createXBookmarksConnectorStore,
  createXBookmarksContentRecoveryHandler,
  createXBookmarksSourceConnector,
  defaultXBookmarksLiveSyncConfig,
  verifyXBookmarksContentRecoveryReceipt,
  xBookmarkFolderNameFacet,
  xBookmarkFolderNameFacetPrefix,
  xBookmarkFolderNameLiteralEscapePrefix,
  type XBookmarkContentLookupClient,
} from '../src/workers/x-bookmarks/index.ts';

const ACCOUNT = 'personal';

describe('X bookmark content recovery', () => {
  test('bounded multi-post lookup requests rich text and author fields and counts unavailable ids', async () => {
    let requestedUrl: URL | undefined;
    const client = new XApiClient({
      token: 'test-token',
      userId: 'provider-user-1',
      fetch: async (input) => {
        requestedUrl = new URL(String(input));
        return new Response(JSON.stringify({
          data: [{
            id: '2076846914813788163',
            text: 'Recovered lookup text.',
            author_id: 'author-1',
          }],
          includes: {
            users: [{ id: 'author-1', username: 'climate_author', name: 'Climate Author' }],
          },
          errors: [{ value: '2076846914813788999', title: 'Not Found Error' }],
        }), { headers: { 'content-type': 'application/json' } });
      },
    });

    const result = await client.fetchPostsByIds([
      '2076846914813788163',
      '2076846914813788999',
    ]);

    expect(requestedUrl?.pathname).toBe('/2/tweets');
    expect(requestedUrl?.searchParams.get('ids'))
      .toBe('2076846914813788163,2076846914813788999');
    expect(requestedUrl?.searchParams.get('tweet.fields')).toContain('text');
    expect(requestedUrl?.searchParams.get('expansions')).toContain('author_id');
    expect(result).toMatchObject({
      unavailableCount: 1,
      posts: [{
        id: '2076846914813788163',
        text: 'Recovered lookup text.',
        authorUsername: 'climate_author',
        authorName: 'Climate Author',
      }],
    });
  });

  test('bounded recovery re-fetches URL-only bookmarks, preserves folder facets, and counts deleted posts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-content-recovery-'));
    const store = createXBookmarksConnectorStore(join(dir, 'x-bookmarks.sqlite'));
    const usage = new LocalXBookmarksApiUsageStore(join(dir, 'x-usage.sqlite'));
    const reconcileState = new LocalXBookmarksReconcileStateStore(
      join(dir, 'x-reconcile.sqlite'),
    );
    try {
      const folders = new Map([
        ['2076846914813788163', [{ id: 'folder-climate', name: 'Climate' }]],
        ['2076846914813788999', [{ id: 'folder-climate', name: 'Climate' }]],
      ]);
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account: ACCOUNT,
        posts: [
          { id: '2076846914813788163' },
          { id: '2076846914813788999' },
        ],
        foldersByPostId: folders,
        fetchedAt: '2026-07-30T10:00:00.000Z',
      }), { fetchContent: true });
      const historicalLiteral = 'x-folder-name:v1:historical-recovery-literal';
      const seeded = new Database(store.dbPath);
      seeded.query(`
        UPDATE items
        SET search_text = search_text || char(10) || ?
        WHERE provider_item_id = ?
      `).run(historicalLiteral, '2076846914813788163');
      seeded.close();
      const climateFacet = xBookmarkFolderNameFacet('Climate');
      store.refreshOwnedSearchTextFacets(
        ['2076846914813788163', '2076846914813788999'].map((providerItemId) => ({
          sourceItem: {
            family: 'x' as const,
            provider: 'x',
            accountScope: ACCOUNT,
            providerItemId,
            localItemId: `${ACCOUNT}:${providerItemId}`,
          },
          namespacePrefix: xBookmarkFolderNameFacetPrefix(),
          literalEscapePrefix: xBookmarkFolderNameLiteralEscapePrefix(),
          exactLines: [climateFacet],
        })),
      );
      const sourceInventorySha256 = 'a'.repeat(64);
      const embeddingProviderFingerprintSha256 = 'c'.repeat(64);
      const facetRun = reconcileState.beginFolderFacetRefreshRun({
        account: ACCOUNT,
        providerUserId: 'provider-user-1',
        sourceInventorySha256,
        embeddingProviderFingerprintSha256,
        algorithmVersion: 2,
      });
      reconcileState.advanceFolderFacetRefresh({
        account: ACCOUNT,
        runToken: facetRun.runToken,
        leaseGeneration: facetRun.leaseGeneration,
        sourceInventorySha256,
        embeddingProviderFingerprintSha256,
        algorithmVersion: 2,
        completed: true,
        counts: {
          itemsScanned: 2,
          itemsRefreshed: 2,
          itemsUnchanged: 0,
          itemsMissing: 0,
          ftsRowsRefreshed: 2,
          chunkEmbeddingInputsInvalidated: 0,
          chunksEmbedded: 0,
          chunksEmbeddingCurrent: 0,
        },
      });
      reconcileState.releaseFolderFacetRefreshRun({
        account: ACCOUNT,
        runToken: facetRun.runToken,
        leaseGeneration: facetRun.leaseGeneration,
      });
      const embeddingCalls: Array<Parameters<typeof store.embedChunks>[0]> = [];
      const embedChunks = store.embedChunks.bind(store);
      store.embedChunks = async (options) => {
        embeddingCalls.push(options);
        return embedChunks(options);
      };
      const embeddingProvider = {
        provider: 'x-content-recovery-test',
        modelId: 'x-content-recovery-test-model',
        dimension: 3,
        configHash: 'x-content-recovery-test-config',
        epochId: 'x-content-recovery-test-epoch',
        backend: 'cloud' as const,
        async embed(batch: Array<{ text: string }>) {
          return batch.map(() => [1, 0, 0]);
        },
      };

      const requested: string[][] = [];
      const client: XBookmarkContentLookupClient = {
        async fetchPostsByIds(postIds) {
          requested.push([...postIds]);
          return {
            posts: [{
              id: '2076846914813788163',
              text: 'Recovered Climate resilience source text.',
              authorId: 'author-1',
              authorUsername: 'climate_author',
              authorName: 'Climate Author',
              createdAt: '2026-07-20T12:00:00.000Z',
            }],
            unavailableCount: 1,
          };
        },
      };
      const config = {
        ...defaultXBookmarksLiveSyncConfig(),
        dailyApiRequestBudget: 10,
        dailyResourceReadBudget: 100,
        dailyEstimatedSpendMicrousd: 1_000_000,
        headApiRequestReserve: 0,
        headResourceReadReserve: 0,
        headEstimatedSpendReserveMicrousd: 0,
      };
      const handler = createXBookmarksContentRecoveryHandler({
        store,
        usageStore: usage,
        reconcileStateStore: reconcileState,
        embeddingProvider,
        sourceClient: client,
        account: ACCOUNT,
        userId: 'provider-user-1',
        config,
        now: () => new Date('2026-07-30T12:00:00.000Z'),
      });

      const receiptPath = `${store.dbPath}.content-recovery-receipt.json`;
      const planned = await handler.recover({ limit: 10 });
      verifyXBookmarksContentRecoveryReceipt(planned);
      expect(planned).toMatchObject({
        status: 'planned',
        counts: {
          candidates_scanned: 2,
          candidates_with_post_url: 2,
          api_requests: 0,
          items_recovered: 0,
        },
      });
      expect(requested).toEqual([]);
      expect(existsSync(receiptPath)).toBe(false);

      const completed = await handler.recover({ limit: 10, execute: true });
      verifyXBookmarksContentRecoveryReceipt(completed);
      expect(completed).toMatchObject({
        status: 'completed',
        counts: {
          candidates_scanned: 2,
          candidates_with_post_url: 2,
          api_requests: 1,
          provider_items_requested: 2,
          provider_items_returned: 1,
          items_recovered: 1,
          items_unrecoverable: 1,
          items_deferred: 0,
          provider_failures: 0,
        },
        policy: {
          counts_only: true,
          raw_source_exposed: false,
          source_text_returned: false,
          resource_ids_exposed: false,
        },
      });
      expect(requested).toEqual([[
        '2076846914813788163',
        '2076846914813788999',
      ]]);
      expect(embeddingCalls).toHaveLength(1);
      expect(embeddingCalls[0]).toMatchObject({
        journalLeaseGeneration: facetRun.leaseGeneration,
      });
      expect(embeddingCalls[0]?.journalId)
        .toMatch(/^x_content_recovery:[a-f0-9]{64}:embeddings$/);

      const folderHits = store.searchItems(
        'recovered climate resilience',
        10,
        ACCOUNT,
        { searchTextExactLines: [xBookmarkFolderNameFacet('Climate')] },
      );
      expect(folderHits).toHaveLength(1);
      expect(folderHits[0]).toMatchObject({
        sourceItem: { providerItemId: '2076846914813788163' },
        authorLabel: 'Climate Author',
      });
      const inspected = new Database(store.dbPath, { readonly: true });
      const row = inspected.query(`
        SELECT search_text FROM items WHERE provider_item_id = ?
      `).get('2076846914813788163') as { search_text: string };
      inspected.close();
      expect(row.search_text.split('\n')).toContain(`x-literal:v1:${historicalLiteral}`);
      expect(row.search_text.split('\n')).not.toContain(historicalLiteral);

      expect(existsSync(receiptPath)).toBe(true);
      expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
      const serializedReceipt = readFileSync(receiptPath, 'utf8');
      expect(serializedReceipt).not.toContain('2076846914813788163');
      expect(serializedReceipt).not.toContain('Recovered Climate resilience');
      expect(usage.status({
        account: ACCOUNT,
        config,
        now: new Date('2026-07-30T12:00:00.000Z'),
      })).toMatchObject({
        api_requests: 1,
      });
    } finally {
      reconcileState.close();
      usage.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('defers recovery for a row whose folder-facet migration page already advanced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-content-running-facet-migration-'));
    const store = createXBookmarksConnectorStore(join(dir, 'x-bookmarks.sqlite'));
    const usage = new LocalXBookmarksApiUsageStore(join(dir, 'x-usage.sqlite'));
    const reconcileState = new LocalXBookmarksReconcileStateStore(
      join(dir, 'x-reconcile.sqlite'),
    );
    const postId = '2076846914813788112';
    const facet = xBookmarkFolderNameFacet('Already Migrated');
    let providerCalls = 0;
    try {
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account: ACCOUNT,
        posts: [{ id: postId }],
        foldersByPostId: new Map([
          [postId, [{ id: 'folder-already-migrated', name: 'Already Migrated' }]],
        ]),
        fetchedAt: '2026-07-30T10:00:00.000Z',
      }), { fetchContent: true });
      store.refreshOwnedSearchTextFacets([{
        sourceItem: {
          family: 'x',
          provider: 'x',
          accountScope: ACCOUNT,
          providerItemId: postId,
          localItemId: `${ACCOUNT}:${postId}`,
        },
        namespacePrefix: xBookmarkFolderNameFacetPrefix(),
        literalEscapePrefix: xBookmarkFolderNameLiteralEscapePrefix(),
        exactLines: [facet],
      }]);
      const sourceInventorySha256 = 'b'.repeat(64);
      const embeddingProviderFingerprintSha256 = 'd'.repeat(64);
      const facetRun = reconcileState.beginFolderFacetRefreshRun({
        account: ACCOUNT,
        providerUserId: 'provider-user-1',
        sourceInventorySha256,
        embeddingProviderFingerprintSha256,
        algorithmVersion: 2,
      });
      reconcileState.advanceFolderFacetRefresh({
        account: ACCOUNT,
        runToken: facetRun.runToken,
        leaseGeneration: facetRun.leaseGeneration,
        sourceInventorySha256,
        embeddingProviderFingerprintSha256,
        algorithmVersion: 2,
        nextCursor: 'page-after-recovery-candidate',
        completed: false,
        counts: {
          itemsScanned: 1,
          itemsRefreshed: 1,
          itemsUnchanged: 0,
          itemsMissing: 0,
          ftsRowsRefreshed: 1,
          chunkEmbeddingInputsInvalidated: 0,
          chunksEmbedded: 0,
          chunksEmbeddingCurrent: 0,
        },
      });

      const receipt = await createXBookmarksContentRecoveryHandler({
        store,
        usageStore: usage,
        reconcileStateStore: reconcileState,
        sourceClient: {
          async fetchPostsByIds() {
            providerCalls += 1;
            return {
              posts: [{ id: postId, text: 'Recovery must wait for migration completion.' }],
              unavailableCount: 0,
            };
          },
        },
        account: ACCOUNT,
        userId: 'provider-user-1',
        config: {
          ...defaultXBookmarksLiveSyncConfig(),
          dailyApiRequestBudget: 10,
          dailyResourceReadBudget: 100,
          dailyEstimatedSpendMicrousd: 1_000_000,
          headApiRequestReserve: 0,
          headResourceReadReserve: 0,
          headEstimatedSpendReserveMicrousd: 0,
        },
        now: () => new Date('2026-07-30T12:00:00.000Z'),
      }).recover({ execute: true, limit: 1 });

      expect(receipt).toMatchObject({
        status: 'deferred',
        counts: {
          candidates_with_post_url: 1,
          api_requests: 0,
          provider_items_requested: 0,
          items_recovered: 0,
          items_deferred: 1,
        },
      });
      expect(providerCalls).toBe(0);
      const inspected = new Database(store.dbPath, { readonly: true });
      const row = inspected.query(`
        SELECT search_text FROM items WHERE provider_item_id = ?
      `).get(postId) as { search_text: string };
      inspected.close();
      expect(row.search_text.split('\n')).toContain(facet);
      expect(row.search_text.split('\n'))
        .not.toContain(`${xBookmarkFolderNameLiteralEscapePrefix()}${facet}`);
      expect(usage.status({
        account: ACCOUNT,
        config: defaultXBookmarksLiveSyncConfig(),
        now: new Date('2026-07-30T12:00:00.000Z'),
      }).api_requests).toBe(0);
    } finally {
      reconcileState.close();
      usage.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('defers after provider lookup when folder-facet authority changes generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-content-facet-generation-fence-'));
    const store = createXBookmarksConnectorStore(join(dir, 'x-bookmarks.sqlite'));
    const usage = new LocalXBookmarksApiUsageStore(join(dir, 'x-usage.sqlite'));
    const reconcileState = new LocalXBookmarksReconcileStateStore(
      join(dir, 'x-reconcile.sqlite'),
    );
    const postId = '2076846914813788113';
    const facet = xBookmarkFolderNameFacet('Genuine Facet');
    const firstInventory = 'e'.repeat(64);
    const replacementInventory = 'f'.repeat(64);
    const embeddingFingerprint = '9'.repeat(64);
    let replacementRun: ReturnType<
      LocalXBookmarksReconcileStateStore['beginFolderFacetRefreshRun']
    > | undefined;
    try {
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account: ACCOUNT,
        posts: [{ id: postId }],
        foldersByPostId: new Map([
          [postId, [{ id: 'folder-genuine', name: 'Genuine Facet' }]],
        ]),
        fetchedAt: '2026-07-30T10:00:00.000Z',
      }), { fetchContent: true });
      store.refreshOwnedSearchTextFacets([{
        sourceItem: {
          family: 'x',
          provider: 'x',
          accountScope: ACCOUNT,
          providerItemId: postId,
          localItemId: `${ACCOUNT}:${postId}`,
        },
        namespacePrefix: xBookmarkFolderNameFacetPrefix(),
        literalEscapePrefix: xBookmarkFolderNameLiteralEscapePrefix(),
        exactLines: [facet],
      }]);
      const completedRun = reconcileState.beginFolderFacetRefreshRun({
        account: ACCOUNT,
        providerUserId: 'provider-user-1',
        sourceInventorySha256: firstInventory,
        embeddingProviderFingerprintSha256: embeddingFingerprint,
        algorithmVersion: 2,
      });
      reconcileState.advanceFolderFacetRefresh({
        account: ACCOUNT,
        runToken: completedRun.runToken,
        leaseGeneration: completedRun.leaseGeneration,
        sourceInventorySha256: firstInventory,
        embeddingProviderFingerprintSha256: embeddingFingerprint,
        algorithmVersion: 2,
        completed: true,
        counts: {
          itemsScanned: 1,
          itemsRefreshed: 1,
          itemsUnchanged: 0,
          itemsMissing: 0,
          ftsRowsRefreshed: 1,
          chunkEmbeddingInputsInvalidated: 0,
          chunksEmbedded: 0,
          chunksEmbeddingCurrent: 0,
        },
      });
      reconcileState.releaseFolderFacetRefreshRun({
        account: ACCOUNT,
        runToken: completedRun.runToken,
        leaseGeneration: completedRun.leaseGeneration,
      });

      const receipt = await createXBookmarksContentRecoveryHandler({
        store,
        usageStore: usage,
        reconcileStateStore: reconcileState,
        sourceClient: {
          async fetchPostsByIds() {
            replacementRun = reconcileState.beginFolderFacetRefreshRun({
              account: ACCOUNT,
              providerUserId: 'provider-user-1',
              sourceInventorySha256: replacementInventory,
              embeddingProviderFingerprintSha256: embeddingFingerprint,
              algorithmVersion: 2,
            });
            reconcileState.advanceFolderFacetRefresh({
              account: ACCOUNT,
              runToken: replacementRun.runToken,
              leaseGeneration: replacementRun.leaseGeneration,
              sourceInventorySha256: replacementInventory,
              embeddingProviderFingerprintSha256: embeddingFingerprint,
              algorithmVersion: 2,
              nextCursor: 'page-after-recovery-candidate',
              completed: false,
              counts: {
                itemsScanned: 1,
                itemsRefreshed: 1,
                itemsUnchanged: 0,
                itemsMissing: 0,
                ftsRowsRefreshed: 1,
                chunkEmbeddingInputsInvalidated: 0,
                chunksEmbedded: 0,
                chunksEmbeddingCurrent: 0,
              },
            });
            return {
              posts: [{ id: postId, text: 'Recovered text must wait for the new generation.' }],
              unavailableCount: 0,
            };
          },
        },
        account: ACCOUNT,
        userId: 'provider-user-1',
        config: {
          ...defaultXBookmarksLiveSyncConfig(),
          dailyApiRequestBudget: 10,
          dailyResourceReadBudget: 100,
          dailyEstimatedSpendMicrousd: 1_000_000,
          headApiRequestReserve: 0,
          headResourceReadReserve: 0,
          headEstimatedSpendReserveMicrousd: 0,
        },
        now: () => new Date('2026-07-30T12:00:00.000Z'),
      }).recover({ execute: true, limit: 1 });

      expect(receipt).toMatchObject({
        status: 'deferred',
        counts: {
          api_requests: 1,
          provider_items_requested: 1,
          provider_items_returned: 1,
          items_recovered: 0,
          items_deferred: 1,
        },
      });
      expect(replacementRun).toBeDefined();
      const activeRun = replacementRun!;
      reconcileState.advanceFolderFacetRefresh({
        account: ACCOUNT,
        runToken: activeRun.runToken,
        leaseGeneration: activeRun.leaseGeneration,
        sourceInventorySha256: replacementInventory,
        embeddingProviderFingerprintSha256: embeddingFingerprint,
        algorithmVersion: 2,
        expectedCursor: 'page-after-recovery-candidate',
        completed: true,
        counts: {
          itemsScanned: 0,
          itemsRefreshed: 0,
          itemsUnchanged: 0,
          itemsMissing: 0,
          ftsRowsRefreshed: 0,
          chunkEmbeddingInputsInvalidated: 0,
          chunksEmbedded: 0,
          chunksEmbeddingCurrent: 0,
        },
      });
      reconcileState.releaseFolderFacetRefreshRun({
        account: ACCOUNT,
        runToken: activeRun.runToken,
        leaseGeneration: activeRun.leaseGeneration,
      });
      const inspected = new Database(store.dbPath, { readonly: true });
      const row = inspected.query(`
        SELECT search_text FROM items WHERE provider_item_id = ?
      `).get(postId) as { search_text: string };
      inspected.close();
      expect(row.search_text.split('\n')).toContain(facet);
      expect(row.search_text.split('\n'))
        .not.toContain(`${xBookmarkFolderNameLiteralEscapePrefix()}${facet}`);
    } finally {
      reconcileState.close();
      usage.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('defers after provider lookup when a reset would otherwise recycle authority generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-content-facet-reset-aba-'));
    const store = createXBookmarksConnectorStore(join(dir, 'x-bookmarks.sqlite'));
    const usage = new LocalXBookmarksApiUsageStore(join(dir, 'x-usage.sqlite'));
    const reconcileState = new LocalXBookmarksReconcileStateStore(
      join(dir, 'x-reconcile.sqlite'),
    );
    const postId = '2076846914813788114';
    const firstInventory = '1'.repeat(64);
    const replacementInventory = '2'.repeat(64);
    const firstEmbeddingFingerprint = '3'.repeat(64);
    const replacementEmbeddingFingerprint = '4'.repeat(64);
    try {
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account: ACCOUNT,
        posts: [{ id: postId }],
        fetchedAt: '2026-07-30T10:00:00.000Z',
      }), { fetchContent: true });
      const firstRun = reconcileState.beginFolderFacetRefreshRun({
        account: ACCOUNT,
        providerUserId: 'provider-user-1',
        sourceInventorySha256: firstInventory,
        embeddingProviderFingerprintSha256: firstEmbeddingFingerprint,
        algorithmVersion: 2,
      });
      reconcileState.advanceFolderFacetRefresh({
        account: ACCOUNT,
        runToken: firstRun.runToken,
        leaseGeneration: firstRun.leaseGeneration,
        sourceInventorySha256: firstInventory,
        embeddingProviderFingerprintSha256: firstEmbeddingFingerprint,
        algorithmVersion: 2,
        completed: true,
        counts: {
          itemsScanned: 1,
          itemsRefreshed: 0,
          itemsUnchanged: 1,
          itemsMissing: 0,
          ftsRowsRefreshed: 0,
          chunkEmbeddingInputsInvalidated: 0,
          chunksEmbedded: 0,
          chunksEmbeddingCurrent: 0,
        },
      });
      reconcileState.releaseFolderFacetRefreshRun({
        account: ACCOUNT,
        runToken: firstRun.runToken,
        leaseGeneration: firstRun.leaseGeneration,
      });

      let replacementGeneration = 0;
      const receipt = await createXBookmarksContentRecoveryHandler({
        store,
        usageStore: usage,
        reconcileStateStore: reconcileState,
        sourceClient: {
          async fetchPostsByIds() {
            expect(reconcileState.resetFolderFacetRefresh(
              ACCOUNT,
              'embedding_provider_migration',
            )).toBe(true);
            const replacement = reconcileState.beginFolderFacetRefreshRun({
              account: ACCOUNT,
              providerUserId: 'provider-user-1',
              sourceInventorySha256: replacementInventory,
              embeddingProviderFingerprintSha256: replacementEmbeddingFingerprint,
              algorithmVersion: 2,
            });
            replacementGeneration = replacement.leaseGeneration;
            reconcileState.advanceFolderFacetRefresh({
              account: ACCOUNT,
              runToken: replacement.runToken,
              leaseGeneration: replacement.leaseGeneration,
              sourceInventorySha256: replacementInventory,
              embeddingProviderFingerprintSha256: replacementEmbeddingFingerprint,
              algorithmVersion: 2,
              nextCursor: 'page-after-recovery-candidate',
              completed: false,
              counts: {
                itemsScanned: 1,
                itemsRefreshed: 0,
                itemsUnchanged: 1,
                itemsMissing: 0,
                ftsRowsRefreshed: 0,
                chunkEmbeddingInputsInvalidated: 0,
                chunksEmbedded: 0,
                chunksEmbeddingCurrent: 0,
              },
            });
            reconcileState.advanceFolderFacetRefresh({
              account: ACCOUNT,
              runToken: replacement.runToken,
              leaseGeneration: replacement.leaseGeneration,
              sourceInventorySha256: replacementInventory,
              embeddingProviderFingerprintSha256: replacementEmbeddingFingerprint,
              algorithmVersion: 2,
              expectedCursor: 'page-after-recovery-candidate',
              completed: true,
              counts: {
                itemsScanned: 0,
                itemsRefreshed: 0,
                itemsUnchanged: 0,
                itemsMissing: 0,
                ftsRowsRefreshed: 0,
                chunkEmbeddingInputsInvalidated: 0,
                chunksEmbedded: 0,
                chunksEmbeddingCurrent: 0,
              },
            });
            reconcileState.releaseFolderFacetRefreshRun({
              account: ACCOUNT,
              runToken: replacement.runToken,
              leaseGeneration: replacement.leaseGeneration,
            });
            return {
              posts: [{ id: postId, text: 'A stale recovery must not cross provider migration.' }],
              unavailableCount: 0,
            };
          },
        },
        account: ACCOUNT,
        userId: 'provider-user-1',
        config: {
          ...defaultXBookmarksLiveSyncConfig(),
          dailyApiRequestBudget: 10,
          dailyResourceReadBudget: 100,
          dailyEstimatedSpendMicrousd: 1_000_000,
          headApiRequestReserve: 0,
          headResourceReadReserve: 0,
          headEstimatedSpendReserveMicrousd: 0,
        },
        now: () => new Date('2026-07-30T12:00:00.000Z'),
      }).recover({ execute: true, limit: 1 });

      expect(firstRun.leaseGeneration).toBe(1);
      expect(replacementGeneration).toBeGreaterThan(firstRun.leaseGeneration);
      expect(receipt).toMatchObject({
        status: 'deferred',
        counts: {
          api_requests: 1,
          provider_items_requested: 1,
          provider_items_returned: 1,
          items_recovered: 0,
          items_deferred: 1,
        },
      });
    } finally {
      reconcileState.close();
      usage.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves stored facet lines to the account-wide refresh rather than escaping them mid-recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-content-non-member-facet-'));
    const store = createXBookmarksConnectorStore(join(dir, 'x-bookmarks.sqlite'));
    const usage = new LocalXBookmarksApiUsageStore(join(dir, 'x-usage.sqlite'));
    const postId = '2076846914813788111';
    const falseFacet = xBookmarkFolderNameFacet('Climate');
    try {
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account: ACCOUNT,
        posts: [{ id: postId }],
        fetchedAt: '2026-07-30T10:00:00.000Z',
      }), { fetchContent: true });
      const seeded = new Database(store.dbPath);
      seeded.query(`
        UPDATE items SET search_text = ? WHERE provider_item_id = ?
      `).run(`Climate\n${falseFacet}`, postId);
      seeded.close();

      const receipt = await createXBookmarksContentRecoveryHandler({
        store,
        usageStore: usage,
        sourceClient: {
          async fetchPostsByIds() {
            return {
              posts: [{ id: postId, text: 'Recovered folderless climate marker.' }],
              unavailableCount: 0,
            };
          },
        },
        account: ACCOUNT,
        userId: 'provider-user-1',
        config: {
          ...defaultXBookmarksLiveSyncConfig(),
          dailyApiRequestBudget: 10,
          dailyResourceReadBudget: 100,
          dailyEstimatedSpendMicrousd: 1_000_000,
          headApiRequestReserve: 0,
          headResourceReadReserve: 0,
          headEstimatedSpendReserveMicrousd: 0,
        },
        now: () => new Date('2026-07-30T12:00:00.000Z'),
      }).recover({ execute: true, limit: 1 });
      expect(receipt).toMatchObject({
        status: 'completed',
        counts: { items_recovered: 1 },
      });

      // A forged facet is already live in search_text before recovery runs, so
      // escaping it here would guard nothing while destroying the genuine
      // facets on every item that happens to pass through recovery. Recovery
      // hands back what it was given.
      const inspected = new Database(store.dbPath, { readonly: true });
      const row = inspected.query(`
        SELECT search_text FROM items WHERE provider_item_id = ?
      `).get(postId) as { search_text: string };
      inspected.close();
      expect(row.search_text.split('\n')).toContain(falseFacet);
      expect(row.search_text.split('\n')).not.toContain(`x-literal:v1:${falseFacet}`);

      // The account-wide refresh is the control that owns the namespace, and it
      // still escapes the line the item has no folder authority for.
      store.refreshOwnedSearchTextFacets([{
        sourceItem: {
          family: 'x' as const,
          provider: 'x',
          accountScope: ACCOUNT,
          providerItemId: postId,
          localItemId: `${ACCOUNT}:${postId}`,
        },
        namespacePrefix: xBookmarkFolderNameFacetPrefix(),
        literalEscapePrefix: xBookmarkFolderNameLiteralEscapePrefix(),
        exactLines: [],
      }]);
      expect(store.searchItems(
        'recovered folderless climate marker',
        5,
        ACCOUNT,
        { searchTextExactLines: [falseFacet] },
      )).toEqual([]);
      const refreshed = new Database(store.dbPath, { readonly: true });
      const refreshedRow = refreshed.query(`
        SELECT search_text FROM items WHERE provider_item_id = ?
      `).get(postId) as { search_text: string };
      refreshed.close();
      expect(refreshedRow.search_text.split('\n')).toContain(`x-literal:v1:${falseFacet}`);
      expect(refreshedRow.search_text.split('\n')).not.toContain(falseFacet);
    } finally {
      usage.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('credential failure before provider dispatch consumes no durable request budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-content-credential-failure-'));
    const store = createXBookmarksConnectorStore(join(dir, 'x-bookmarks.sqlite'));
    const usagePath = join(dir, 'x-usage.sqlite');
    const usage = new LocalXBookmarksApiUsageStore(usagePath);
    try {
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account: ACCOUNT,
        posts: [{ id: '2076846914813788163' }],
        fetchedAt: '2026-07-30T10:00:00.000Z',
      }), { fetchContent: true });
      const config = {
        ...defaultXBookmarksLiveSyncConfig(),
        dailyApiRequestBudget: 10,
        dailyResourceReadBudget: 100,
        dailyEstimatedSpendMicrousd: 1_000_000,
        headApiRequestReserve: 0,
        headResourceReadReserve: 0,
        headEstimatedSpendReserveMicrousd: 0,
      };
      const attemptedAt = new Date('2026-07-30T12:00:00.000Z');
      const result = await createXBookmarksContentRecoveryHandler({
        store,
        usageStore: usage,
        credentialBroker: {
          async issueSession() {
            throw new Error('credential broker unavailable');
          },
        },
        account: ACCOUNT,
        userId: 'provider-user-1',
        config,
        now: () => attemptedAt,
      }).recover({ execute: true, limit: 1 });

      expect(result).toMatchObject({
        status: 'failed',
        counts: {
          api_requests: 0,
          provider_items_requested: 0,
          provider_items_returned: 0,
        },
      });
      expect(usage.status({ account: ACCOUNT, config, now: attemptedAt })).toMatchObject({
        api_requests: 0,
        reserved_resource_reads: 0,
      });
    } finally {
      usage.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('credential delay cannot cross the UTC budget boundary or outlive its lease', async () => {
    for (const scenario of ['midnight_budget', 'expired_lease'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `olympus-x-content-${scenario}-`));
      const store = createXBookmarksConnectorStore(join(dir, 'x-bookmarks.sqlite'));
      const usage = new LocalXBookmarksApiUsageStore(join(dir, 'x-usage.sqlite'));
      const config = {
        ...defaultXBookmarksLiveSyncConfig(),
        dailyApiRequestBudget: 1,
        dailyResourceReadBudget: 100,
        dailyEstimatedSpendMicrousd: 1_000_000,
        headApiRequestReserve: 0,
        headResourceReadReserve: 0,
        headEstimatedSpendReserveMicrousd: 0,
      };
      let current = new Date('2026-07-30T23:59:59.000Z');
      let providerCalls = 0;
      try {
        await store.syncFromConnector(createXBookmarksSourceConnector({
          account: ACCOUNT,
          posts: [{ id: '2076846914813788163' }],
          fetchedAt: '2026-07-30T10:00:00.000Z',
        }), { fetchContent: true });
        if (scenario === 'midnight_budget') {
          usage.reserveRequest({
            account: ACCOUNT,
            requestedMaxResources: 1,
            config,
            now: new Date('2026-07-31T00:00:00.000Z'),
          });
        }
        const receipt = await createXBookmarksContentRecoveryHandler({
          store,
          usageStore: usage,
          account: ACCOUNT,
          userId: 'provider-user-1',
          config,
          now: () => current,
          credentialBroker: {
            async issueSession() {
              current = scenario === 'midnight_budget'
                ? new Date('2026-07-31T00:00:01.000Z')
                : new Date('2026-07-31T00:05:00.001Z');
              return {
                kind: 'bearer_token',
                handle: 'x.bookmarks.personal',
                provider: 'x',
                capability: 'x.bookmarks.sync',
                token: 'test-token',
                audit: {
                  handle: 'x.bookmarks.personal',
                  provider: 'x',
                  capability: 'x.bookmarks.sync',
                  trustDomain: 'internal',
                  scopes: [],
                  outcome: 'issued',
                  issuedAt: current.toISOString(),
                  rawCredentialExposed: false,
                },
              };
            },
          },
          fetch: async () => {
            providerCalls += 1;
            return new Response(JSON.stringify({ data: [] }), {
              headers: { 'content-type': 'application/json' },
            });
          },
        }).recover({ execute: true, limit: 1 });
        expect(receipt).toMatchObject({
          status: scenario === 'midnight_budget' ? 'deferred' : 'failed',
          counts: {
            api_requests: 0,
            provider_items_requested: 0,
            items_deferred: 1,
          },
        });
        expect(providerCalls).toBe(0);
        expect(usage.status({ account: ACCOUNT, config, now: current })).toMatchObject({
          api_requests: scenario === 'midnight_budget' ? 1 : 0,
          reserved_resource_reads: scenario === 'midnight_budget' ? 1 : 0,
        });
      } finally {
        usage.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('an abandoned pre-dispatch reservation expires without permanent budget consumption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-content-abandoned-reservation-'));
    const usagePath = join(dir, 'x-usage.sqlite');
    const config = {
      ...defaultXBookmarksLiveSyncConfig(),
      dailyApiRequestBudget: 1,
      dailyResourceReadBudget: 12,
      dailyEstimatedSpendMicrousd: 1_000_000,
      headApiRequestReserve: 0,
      headResourceReadReserve: 0,
      headEstimatedSpendReserveMicrousd: 0,
    };
    const reservedAt = new Date('2026-07-30T12:00:00.000Z');
    let usage = new LocalXBookmarksApiUsageStore(usagePath);
    try {
      usage.reserveRequest({
        account: ACCOUNT,
        requestedMaxResources: 6,
        countApiRequestOnDispatch: true,
        config,
        now: reservedAt,
      });
      expect(usage.status({ account: ACCOUNT, config, now: reservedAt })).toMatchObject({
        api_requests: 0,
        reserved_resource_reads: 6,
        guard: { state: 'exhausted', degraded_reason: 'daily_api_request_guard' },
      });
      usage.close();

      usage = new LocalXBookmarksApiUsageStore(usagePath);
      const afterLease = new Date('2026-07-30T12:06:00.000Z');
      expect(usage.status({ account: ACCOUNT, config, now: afterLease })).toMatchObject({
        api_requests: 0,
        reserved_resource_reads: 0,
      });
      const replacement = usage.reserveRequest({
        account: ACCOUNT,
        requestedMaxResources: 6,
        countApiRequestOnDispatch: true,
        config,
        now: afterLease,
      });
      usage.markRequestDispatched({
        reservation: replacement,
        config,
        now: afterLease,
      });
      expect(usage.status({ account: ACCOUNT, config, now: afterLease })).toMatchObject({
        api_requests: 1,
      });
      usage.settleFailure({
        reservation: replacement,
        potentiallyBillable: false,
        config,
        now: afterLease,
      });
    } finally {
      usage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cross-midnight dispatch charges and rechecks the fresh UTC day', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-content-midnight-dispatch-'));
    const usage = new LocalXBookmarksApiUsageStore(join(dir, 'x-usage.sqlite'));
    const config = {
      ...defaultXBookmarksLiveSyncConfig(),
      dailyApiRequestBudget: 1,
      dailyResourceReadBudget: 12,
      dailyEstimatedSpendMicrousd: 1_000_000,
      headApiRequestReserve: 0,
      headResourceReadReserve: 0,
      headEstimatedSpendReserveMicrousd: 0,
    };
    const reservedAt = new Date('2026-07-30T23:59:59.000Z');
    const dispatchedAt = new Date('2026-07-31T00:00:01.000Z');
    try {
      const reservation = usage.reserveRequest({
        account: ACCOUNT,
        requestedMaxResources: 1,
        countApiRequestOnDispatch: true,
        config,
        now: reservedAt,
      });
      usage.markRequestDispatched({
        reservation,
        config,
        now: dispatchedAt,
      });
      expect(usage.status({ account: ACCOUNT, config, now: reservedAt }).api_requests).toBe(0);
      expect(usage.status({ account: ACCOUNT, config, now: dispatchedAt }).api_requests).toBe(1);
      expect(() => usage.reserveRequest({
        account: ACCOUNT,
        requestedMaxResources: 1,
        countApiRequestOnDispatch: true,
        config,
        now: dispatchedAt,
      })).toThrow('daily_api_request_guard');
    } finally {
      usage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('daily X budget exhaustion defers every candidate without provider I/O', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-content-budget-'));
    const store = createXBookmarksConnectorStore(join(dir, 'x-bookmarks.sqlite'));
    const usage = new LocalXBookmarksApiUsageStore(join(dir, 'x-usage.sqlite'));
    try {
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account: ACCOUNT,
        posts: [{ id: '2076846914813788163' }],
        fetchedAt: '2026-07-30T10:00:00.000Z',
      }), { fetchContent: true });
      let providerCalls = 0;
      const config = {
        ...defaultXBookmarksLiveSyncConfig(),
        dailyApiRequestBudget: 1,
        dailyResourceReadBudget: 100,
        dailyEstimatedSpendMicrousd: 1_000_000,
        headApiRequestReserve: 1,
        headResourceReadReserve: 0,
        headEstimatedSpendReserveMicrousd: 0,
      };
      const handler = createXBookmarksContentRecoveryHandler({
        store,
        usageStore: usage,
        sourceClient: {
          async fetchPostsByIds() {
            providerCalls += 1;
            return { posts: [], unavailableCount: 0 };
          },
        },
        account: ACCOUNT,
        userId: 'provider-user-1',
        config,
        now: () => new Date('2026-07-30T00:00:00.000Z'),
      });

      const result = await handler.recover({ execute: true, limit: 1 });
      expect(result).toMatchObject({
        status: 'deferred',
        counts: {
          candidates_scanned: 1,
          api_requests: 0,
          items_unrecoverable: 0,
          items_deferred: 1,
        },
      });
      expect(result.retry_at).toBe('2026-07-31T00:00:00.000Z');
      expect(providerCalls).toBe(0);
    } finally {
      usage.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
