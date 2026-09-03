// Content recovery restores text for a bookmark that landed metadata-only. It
// must not take the folder facets down with it.
//
// The facets on a store whose rows were always written by the current codec are
// genuine, and that store has no folder-facet refresh row — nothing ever needed
// migrating. Reading "no completed refresh run" as "these lines are not mine"
// escapes the very facets the restore is meant to preserve, and the recovery
// item itself carries no folder list to re-emit them from.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  createXBookmarksConnectorStore,
  createXBookmarksContentRecoveryHandler,
  createXBookmarksSourceConnector,
  defaultXBookmarksLiveSyncConfig,
  xBookmarkFolderNameFacet,
  type XBookmarkContentLookupClient,
} from '../src/workers/x-bookmarks/index.ts';

const ACCOUNT = 'personal';
const POST_ID = '2076846914813788163';

const RECOVERY_CONFIG = {
  ...defaultXBookmarksLiveSyncConfig(),
  dailyApiRequestBudget: 10,
  dailyResourceReadBudget: 100,
  dailyEstimatedSpendMicrousd: 1_000_000,
  headApiRequestReserve: 0,
  headResourceReadReserve: 0,
  headEstimatedSpendReserveMicrousd: 0,
};

const LOOKUP_CLIENT: XBookmarkContentLookupClient = {
  async fetchPostsByIds() {
    return {
      posts: [{ id: POST_ID, text: 'Recovered Climate resilience source text.' }],
      unavailableCount: 0,
    };
  },
};

describe('X bookmark content recovery: folder facets', () => {
  test('a codec-written facet survives recovery on a store that never needed a refresh run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-recovery-facet-'));
    const store = createXBookmarksConnectorStore(join(dir, 'x-bookmarks.sqlite'));
    const usage = new LocalXBookmarksApiUsageStore(join(dir, 'x-usage.sqlite'));
    // A real state store with no folder-facet refresh row: the ordinary shape
    // of a store whose facets were written natively by the listing connector.
    const reconcileState = new LocalXBookmarksReconcileStateStore(join(dir, 'x-reconcile.sqlite'));
    try {
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account: ACCOUNT,
        posts: [{ id: POST_ID }],
        foldersByPostId: new Map([[POST_ID, [{ id: 'folder-climate', name: 'Climate' }]]]),
        fetchedAt: '2026-07-30T10:00:00.000Z',
      }), { fetchContent: true });

      const climateFacet = xBookmarkFolderNameFacet('Climate');
      const seeded = new Database(store.dbPath, { readonly: true });
      const before = seeded.query('SELECT search_text FROM items WHERE provider_item_id = ?')
        .get(POST_ID) as { search_text: string };
      seeded.close();
      expect(before.search_text.split('\n')).toContain(climateFacet);

      const receipt = await createXBookmarksContentRecoveryHandler({
        store,
        usageStore: usage,
        reconcileStateStore: reconcileState,
        sourceClient: LOOKUP_CLIENT,
        account: ACCOUNT,
        userId: 'provider-user-1',
        config: RECOVERY_CONFIG,
        now: () => new Date('2026-07-30T12:00:00.000Z'),
      }).recover({ execute: true, limit: 1 });

      expect(receipt).toMatchObject({ status: 'completed', counts: { items_recovered: 1 } });

      const folderHits = store.searchItems(
        'recovered climate resilience',
        5,
        ACCOUNT,
        { searchTextExactLines: [climateFacet] },
      );
      expect(folderHits).toHaveLength(1);
      expect(folderHits[0]).toMatchObject({ sourceItem: { providerItemId: POST_ID } });

      const inspected = new Database(store.dbPath, { readonly: true });
      const after = inspected.query('SELECT search_text FROM items WHERE provider_item_id = ?')
        .get(POST_ID) as { search_text: string };
      inspected.close();
      expect(after.search_text.split('\n')).toContain(climateFacet);
    } finally {
      reconcileState.close();
      usage.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
