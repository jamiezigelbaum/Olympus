import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LocalConnectorStore,
} from '../src/workers/connector-store/index.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  createDropboxProviderStoreSyncHandler,
  createDropboxSourceConnector,
  dropboxConnectorIdForScope,
  type DropboxMetadataClient,
  type DropboxMetadataContinueRequest,
  type DropboxMetadataListRequest,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';
import {
  DropboxApiMetadataClient,
  DropboxCursorResetError,
  DropboxRateLimitError,
  isDropboxCursorResetError,
} from '../src/workers/dropbox-files/provider-client.ts';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Dropbox canonical provider-to-store runtime', () => {
  test('the direct provider client requests deleted entries and does not invent a continuation limit', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = new DropboxApiMetadataClient({
      token: 'test-token',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ entries: [], cursor: 'next', has_more: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await client.listFolder({ path: '/Approved', recursive: true, limit: 2000, includeDeleted: true });
    await client.listFolderContinue({ cursor: 'next', limit: 17 });

    expect(bodies).toEqual([
      {
        path: '/Approved',
        recursive: true,
        limit: 2000,
        include_deleted: true,
        include_has_explicit_shared_members: false,
      },
      { cursor: 'next' },
    ]);
  });

  test('the direct provider client surfaces an invalidated cursor as a typed reset, body discarded', async () => {
    const client = new DropboxApiMetadataClient({
      token: 'test-token',
      fetch: async () => new Response(
        JSON.stringify({
          error_summary: 'reset/...',
          error: { '.tag': 'reset' },
          user_message: { text: 'Cursor for /Approved/Taxes 2025 is no longer valid.' },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    });

    const error = await client.listFolderContinue({ cursor: 'dead-cursor', limit: 100 })
      .then(() => undefined, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DropboxCursorResetError);
    expect(isDropboxCursorResetError(error)).toBe(true);
    expect((error as DropboxCursorResetError).status).toBe(409);
    expect((error as Error).message).not.toContain('/Approved/Taxes 2025');
  });

  test('the direct provider client honors Retry-After and then fails typed instead of bare', async () => {
    const retried: Array<{ delays: number[]; attempts: number }> = [];

    const delays: number[] = [];
    let attempts = 0;
    const recovering = new DropboxApiMetadataClient({
      token: 'test-token',
      maxRetries: 2,
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(
            JSON.stringify({ error_summary: 'too_many_requests/...', error: { '.tag': 'too_many_requests' } }),
            { status: 429, headers: { 'retry-after': '3', 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ entries: [], cursor: 'after-limit', has_more: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const page = await recovering.listFolder({ path: '/Approved', recursive: true, limit: 100 });
    retried.push({ delays: [...delays], attempts });
    expect(page).toEqual({ entries: [], cursor: 'after-limit', hasMore: false });
    expect(retried[0]).toEqual({ delays: [3_000], attempts: 2 });

    const exhaustedDelays: number[] = [];
    let exhaustedAttempts = 0;
    const exhausted = new DropboxApiMetadataClient({
      token: 'test-token',
      maxRetries: 1,
      sleep: async (ms) => {
        exhaustedDelays.push(ms);
      },
      fetch: async () => {
        exhaustedAttempts += 1;
        return new Response(
          JSON.stringify({ error_summary: 'too_many_requests/...', error: { '.tag': 'too_many_requests' } }),
          { status: 429, headers: { 'retry-after': '5', 'content-type': 'application/json' } },
        );
      },
    });
    const error = await exhausted.listFolderContinue({ cursor: 'live-cursor', limit: 100 })
      .then(() => undefined, (thrown: unknown) => thrown);

    expect(exhaustedAttempts).toBe(2);
    expect(exhaustedDelays).toEqual([5_000]);
    expect(error).toBeInstanceOf(DropboxRateLimitError);
    expect((error as DropboxRateLimitError).retryAfterMs).toBe(5_000);
    // The shared scheduler classifies failures from the message alone, and a
    // bare "request failed (429)" was indistinguishable from a broken lane.
    expect((error as Error).message).toMatch(/rate limited/i);
  });

  test('a provider cursor reset restarts the traversal instead of wedging the lane forever', async () => {
    const calls: string[] = [];
    let resetPending = true;
    const metadataClient: DropboxMetadataClient = {
      supportsNativeRecursive: true,
      async listFolder(request): Promise<DropboxMetadataPage> {
        calls.push(`list:${request.limit}`);
        return { entries: [file('id:1')], cursor: 'cursor-1', hasMore: false };
      },
      async listFolderContinue(request): Promise<DropboxMetadataPage> {
        calls.push(`continue:${request.cursor}`);
        if (resetPending) {
          resetPending = false;
          throw new DropboxCursorResetError();
        }
        return { entries: [file('id:2')], cursor: 'cursor-2', hasMore: false };
      },
    };
    const { store, close } = testStore();
    try {
      const sync = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient,
      });
      const connectorId = sync.connectorIdForScope('dropbox.personal:/');

      await sync.pull({ approved_scope_key: 'dropbox.personal:/', max_items: 5 });
      expect(store.lastCompletedSyncRun(connectorId)?.cursor).toBe('cursor-1');

      const afterReset = await sync.pull({ approved_scope_key: 'dropbox.personal:/', max_items: 5 });
      expect(afterReset.receipt.counts.resume_cursor_reset).toBe(1);
      expect(afterReset.receipt.counts.resumed_from_checkpoint).toBe(0);
      expect(afterReset.receipt.counts.traversal_complete).toBe(1);
      expect(afterReset.receipt.warnings).toEqual([
        'provider_cursor_reset: provider invalidated the resume cursor; traversal restarted from the beginning.',
      ]);
      expect(afterReset.checkpoint).toBe('cursor-1');

      const next = await sync.pull({ approved_scope_key: 'dropbox.personal:/', max_items: 5 });
      expect(next.receipt.counts.resume_cursor_reset).toBe(0);
      expect(next.receipt.counts.resumed_from_checkpoint).toBe(1);
      expect(store.itemPresence(identityFor('id:2'))).toEqual({ active: true });
      expect(calls).toEqual([
        'list:5',
        'continue:cursor-1',
        'list:5',
        'continue:cursor-1',
      ]);
    } finally {
      close();
    }
  });

  test('a rate-limited pull fails without discarding the still-valid resume cursor', async () => {
    const calls: string[] = [];
    let rateLimitPending = true;
    const metadataClient: DropboxMetadataClient = {
      supportsNativeRecursive: true,
      async listFolder(request): Promise<DropboxMetadataPage> {
        calls.push(`list:${request.limit}`);
        return { entries: [file('id:1')], cursor: 'cursor-1', hasMore: false };
      },
      async listFolderContinue(request): Promise<DropboxMetadataPage> {
        calls.push(`continue:${request.cursor}`);
        if (rateLimitPending) {
          rateLimitPending = false;
          throw new DropboxRateLimitError({ retryAfterMs: 30_000 });
        }
        return { entries: [file('id:2')], cursor: 'cursor-2', hasMore: false };
      },
    };
    const { store, close } = testStore();
    try {
      const sync = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient,
      });
      const connectorId = sync.connectorIdForScope('dropbox.personal:/');

      await sync.pull({ approved_scope_key: 'dropbox.personal:/', max_items: 5 });
      await expect(sync.pull({ approved_scope_key: 'dropbox.personal:/', max_items: 5 }))
        .rejects.toThrow(/rate limited/i);
      // A rate limit is the provider asking for a later run, not a dead cursor:
      // restarting the traversal here would throw away real progress.
      expect(store.lastCompletedSyncRun(connectorId)?.cursor).toBe('cursor-1');

      const resumed = await sync.pull({ approved_scope_key: 'dropbox.personal:/', max_items: 5 });
      expect(resumed.receipt.counts.resumed_from_checkpoint).toBe(1);
      expect(resumed.receipt.counts.resume_cursor_reset).toBe(0);
      expect(store.itemPresence(identityFor('id:2'))).toEqual({ active: true });
      expect(calls).toEqual([
        'list:5',
        'continue:cursor-1',
        'continue:cursor-1',
      ]);
    } finally {
      close();
    }
  });

  test('resumes a native recursive cursor and applies a path-only deletion to the stable item id', async () => {
    const calls: Array<DropboxMetadataListRequest | DropboxMetadataContinueRequest> = [];
    const metadataClient: DropboxMetadataClient = {
      supportsNativeRecursive: true,
      async listFolder(request): Promise<DropboxMetadataPage> {
        calls.push(request);
        return {
          entries: [{
            tag: 'file',
            id: 'id:stable-file',
            name: 'Old Draft.txt',
            pathDisplay: '/Approved/Old Draft.txt',
            pathLower: '/approved/old draft.txt',
            rev: 'rev-1',
          }],
          cursor: 'provider-cursor-1',
          hasMore: false,
        };
      },
      async listFolderContinue(request): Promise<DropboxMetadataPage> {
        calls.push(request);
        return {
          entries: [{
            tag: 'deleted',
            name: 'Old Draft.txt',
            pathDisplay: '/Approved/Old Draft.txt',
            pathLower: '/approved/old draft.txt',
          }],
          cursor: 'provider-cursor-2',
          hasMore: false,
        };
      },
    };
    const { store, close } = testStore();
    try {
      const sync = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient,
      });

      const first = await sync.pull({
        approved_scope_key: 'dropbox.personal:/Approved',
        max_items: 50,
      });
      expect(first.receipt.counts.items_changed).toBe(1);
      expect(first.receipt.counts.traversal_complete).toBe(1);
      expect(store.itemPresence(identity())).toEqual({ active: true, sourceVersion: 'rev-1' });

      const second = await sync.pull({
        approved_scope_key: 'dropbox.personal:/Approved',
        max_items: 50,
      });
      expect(second.receipt.counts.resumed_from_checkpoint).toBe(1);
      expect(second.receipt.counts.deleted_events_applied).toBe(1);
      expect(store.itemPresence(identity())).toEqual({ active: false });
      expect(calls).toEqual([
        { path: '/Approved', recursive: true, limit: 50, includeDeleted: true },
        { cursor: 'provider-cursor-1', limit: 50 },
      ]);
    } finally {
      close();
    }
  });

  test('an upgraded store converges its locator index instead of stalling on the first deletion', async () => {
    const metadataClient: DropboxMetadataClient = {
      supportsNativeRecursive: true,
      async listFolder(): Promise<DropboxMetadataPage> {
        return {
          entries: [{
            tag: 'file',
            id: 'id:stable-file',
            name: 'Old Draft.txt',
            pathDisplay: '/Approved/Old Draft.txt',
            pathLower: '/approved/old draft.txt',
            rev: 'rev-1',
          }],
          cursor: 'provider-cursor-1',
          hasMore: false,
        };
      },
      async listFolderContinue(): Promise<DropboxMetadataPage> {
        return {
          entries: [{
            tag: 'deleted',
            name: 'Old Draft.txt',
            pathDisplay: '/Approved/Old Draft.txt',
            pathLower: '/approved/old draft.txt',
          }],
          cursor: 'provider-cursor-2',
          hasMore: false,
        };
      },
    };
    const dbPath = testStorePath();
    const seeded = storeAt(dbPath);
    try {
      const first = await createDropboxProviderStoreSyncHandler({
        store: seeded,
        account: 'personal',
        broker: broker(),
        metadataClient,
      }).pull({ approved_scope_key: 'dropbox.personal:/Approved', max_items: 50 });
      expect(first.receipt.counts.items_changed).toBe(1);
    } finally {
      seeded.close();
    }

    rewindLocatorIdentityIndexToMigration(dbPath);

    const upgraded = storeAt(dbPath);
    try {
      expect(upgraded.locatorIdentityIndexStatus()).toEqual({
        state: 'backfill_required',
        cursorItemPk: 0,
        indexedItems: 0,
      });
      const second = await createDropboxProviderStoreSyncHandler({
        store: upgraded,
        account: 'personal',
        broker: broker(),
        metadataClient,
      }).pull({ approved_scope_key: 'dropbox.personal:/Approved', max_items: 50 });

      // The pass must survive the deletion. A thrown run is marked failed, so
      // its cursor is never kept and the next pass replays the same deletion
      // from the same provider page — a permanent metadata stall.
      expect(second.receipt.counts.deleted_events_applied).toBe(1);
      expect(second.receipt.counts.items_rejected).toBe(0);
      expect(second.receipt.warnings).toBeUndefined();
      expect(upgraded.itemPresence(identity())).toEqual({ active: false });
      expect(upgraded.locatorIdentityIndexStatus().state).toBe('ready');
      expect(upgraded.lastCompletedSyncRun(
        dropboxConnectorIdForScope('personal', 'dropbox.personal:/Approved'),
      )?.cursor).toBe('provider-cursor-2');
    } finally {
      upgraded.close();
    }
  });

  test('a still-converging locator index leaves one deletion unresolved instead of killing the listing', async () => {
    const dbPath = testStorePath();
    const seeded = storeAt(dbPath);
    try {
      await createDropboxProviderStoreSyncHandler({
        store: seeded,
        account: 'personal',
        broker: broker(),
        metadataClient: {
          supportsNativeRecursive: true,
          async listFolder(): Promise<DropboxMetadataPage> {
            return { entries: [file('id:a')], hasMore: false };
          },
          async listFolderContinue(): Promise<DropboxMetadataPage> {
            return { entries: [], hasMore: false };
          },
        },
      }).pull({ approved_scope_key: 'dropbox.personal:/' });
    } finally {
      seeded.close();
    }

    rewindLocatorIdentityIndexToMigration(dbPath);

    const upgraded = storeAt(dbPath);
    try {
      const connector = createDropboxSourceConnector({
        account: 'personal',
        broker: broker(),
        deletedItemIdentityResolver: upgraded,
        metadataClient: {
          supportsNativeRecursive: true,
          async listFolder(): Promise<DropboxMetadataPage> {
            return {
              entries: [{ tag: 'deleted', name: 'id:a.txt', pathDisplay: '/id:a.txt' }],
              hasMore: false,
            };
          },
          async listFolderContinue(): Promise<DropboxMetadataPage> {
            return { entries: [], hasMore: false };
          },
        },
      });
      const pages = [];
      for await (const page of connector.listItems()) pages.push(page);
      expect(pages).toHaveLength(1);
      expect(pages[0]!.items[0]!.metadata).toMatchObject({
        deleted: true,
        deletedIdentityResolved: false,
      });
    } finally {
      upgraded.close();
    }
  });

  test('gives each approved root an independent opaque connector identity and cursor', async () => {
    const metadataClient: DropboxMetadataClient = {
      supportsNativeRecursive: true,
      async listFolder(request): Promise<DropboxMetadataPage> {
        return { entries: [], cursor: `cursor:${request.path}`, hasMore: false };
      },
      async listFolderContinue(): Promise<DropboxMetadataPage> {
        throw new Error('unexpected continuation');
      },
    };
    const { store, close } = testStore();
    try {
      const sync = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient,
      });
      const scopeA = 'dropbox.personal:/Approved A';
      const scopeB = 'dropbox.personal:/Approved B';
      await sync.pull({ approved_scope_key: scopeA });
      await sync.pull({ approved_scope_key: scopeB });

      const idA = dropboxConnectorIdForScope('personal', scopeA);
      const idB = dropboxConnectorIdForScope('personal', scopeB);
      expect(idA).not.toBe(idB);
      expect(idA).not.toContain('Approved');
      expect(store.lastCompletedSyncRun(idA)?.cursor).toBe('cursor:/Approved A');
      expect(store.lastCompletedSyncRun(idB)?.cursor).toBe('cursor:/Approved B');
    } finally {
      close();
    }
  });

  test('uses the full traversal budget across continuation pages', async () => {
    const calls: string[] = [];
    const metadataClient: DropboxMetadataClient = {
      supportsNativeRecursive: true,
      async listFolder(request): Promise<DropboxMetadataPage> {
        calls.push(`list:${request.limit}`);
        return {
          entries: [file('id:1'), file('id:2')],
          cursor: 'cursor-after-two',
          hasMore: true,
        };
      },
      async listFolderContinue(request): Promise<DropboxMetadataPage> {
        calls.push(`continue:${request.cursor}:${request.limit}`);
        if (request.cursor === 'cursor-after-two') {
          return {
            entries: [file('id:3')],
            cursor: 'cursor-after-three',
            hasMore: true,
          };
        }
        return {
          entries: [file('id:4')],
          cursor: 'cursor-after-four',
          hasMore: false,
        };
      },
    };
    const { store, close } = testStore();
    try {
      const sync = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient,
      });
      const first = await sync.pull({
        approved_scope_key: 'dropbox.personal:/',
        max_items: 3,
      });
      expect(first.receipt.counts.items_seen).toBe(3);
      expect(first.receipt.counts.traversal_complete).toBe(0);
      expect(first.checkpoint).toBe('cursor-after-three');

      const second = await sync.pull({
        approved_scope_key: 'dropbox.personal:/',
        max_items: 3,
      });
      expect(second.receipt.counts.items_seen).toBe(1);
      expect(second.receipt.counts.traversal_complete).toBe(1);
      expect(calls).toEqual([
        'list:3',
        'continue:cursor-after-two:3',
        'continue:cursor-after-three:3',
      ]);
    } finally {
      close();
    }
  });

  test('reports an unmatched path-only deletion as a gap instead of claiming a tombstone', async () => {
    const { store, close } = testStore();
    try {
      const sync = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient: {
          supportsNativeRecursive: true,
          async listFolder(): Promise<DropboxMetadataPage> {
            return {
              entries: [{
                tag: 'deleted',
                name: 'Never Seen.txt',
                pathDisplay: '/Never Seen.txt',
              }],
              cursor: 'cursor-after-unknown-delete',
              hasMore: false,
            };
          },
          async listFolderContinue(): Promise<DropboxMetadataPage> {
            return { entries: [], hasMore: false };
          },
        },
      });
      const result = await sync.pull({ approved_scope_key: 'dropbox.personal:/' });
      expect(result.receipt.counts.deleted_events_applied).toBe(0);
      expect(result.receipt.counts.items_tombstoned).toBe(0);
      expect(result.receipt.counts.items_rejected).toBe(1);
      expect(result.receipt.warnings).toEqual([
        'deleted_event_target_missing: provider deletion did not match an active stored item.',
      ]);
    } finally {
      close();
    }
  });

  test('fails closed when recursive traversal is not native and checkpoints an oversized provider page', async () => {
    const { store, close } = testStore();
    try {
      const nonNative = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient: {
          supportsNativeRecursive: false,
          async listFolder(): Promise<DropboxMetadataPage> {
            return { entries: [], hasMore: false };
          },
          async listFolderContinue(): Promise<DropboxMetadataPage> {
            return { entries: [], hasMore: false };
          },
        },
      });
      await expect(nonNative.pull({ approved_scope_key: 'dropbox.personal:/' }))
        .rejects.toThrow('requires native recursive listing');

      const overBound = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient: {
          supportsNativeRecursive: true,
          async listFolder(): Promise<DropboxMetadataPage> {
            return {
              entries: [file('id:1'), file('id:2')],
              cursor: 'cursor-over-bound',
              hasMore: false,
            };
          },
          async listFolderContinue(): Promise<DropboxMetadataPage> {
            return { entries: [], hasMore: false };
          },
        },
      });
      const first = await overBound.pull({ approved_scope_key: 'dropbox.personal:/', max_items: 1 });
      expect(first.receipt.counts.items_seen).toBe(1);
      expect(first.receipt.counts.traversal_complete).toBe(0);
      expect(first.checkpoint).toStartWith('dbxp1:');

      const second = await overBound.pull({ approved_scope_key: 'dropbox.personal:/', max_items: 1 });
      expect(second.receipt.counts.items_seen).toBe(1);
      expect(second.receipt.counts.traversal_complete).toBe(1);
    } finally {
      close();
    }
  });

  test('replays a changed page idempotently and reports only a bounded diagnostic', async () => {
    let page: DropboxMetadataPage = {
      entries: [file('id:a'), file('id:b'), file('id:c')],
      hasMore: false,
    };
    const { store, close } = testStore();
    try {
      const sync = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient: {
          supportsNativeRecursive: true,
          async listFolder(): Promise<DropboxMetadataPage> {
            return page;
          },
          async listFolderContinue(): Promise<DropboxMetadataPage> {
            throw new Error('unexpected continuation');
          },
        },
      });

      const first = await sync.pull({
        approved_scope_key: 'dropbox.personal:/',
        max_items: 2,
      });
      expect(first.receipt.counts.items_seen).toBe(2);
      expect(first.receipt.counts.page_digest_restarts).toBe(0);
      expect(first.checkpoint).toStartWith('dbxp1:');
      expect(store.itemPresence(identityFor('id:a'))).toEqual({ active: true });
      expect(store.itemPresence(identityFor('id:b'))).toEqual({ active: true });

      page = {
        entries: [
          file('id:a'),
          { tag: 'deleted', id: 'id:b', name: 'id:b.txt', pathDisplay: '/id:b.txt' },
          file('id:c'),
          file('id:d'),
        ],
        hasMore: false,
      };
      const changed = await sync.pull({
        approved_scope_key: 'dropbox.personal:/',
        max_items: 2,
      });
      expect(changed.receipt.counts.items_seen).toBe(2);
      expect(changed.receipt.counts.items_changed).toBe(0);
      expect(changed.receipt.counts.items_tombstoned).toBe(1);
      expect(changed.receipt.counts.page_digest_restarts).toBe(1);
      expect(changed.receipt.warnings).toEqual([
        'provider_page_digest_changed: bounded resume restarted at the changed page boundary.',
      ]);
      expect(changed.receipt.policy).toMatchObject({
        counts_only: true,
        raw_source_exposed: false,
        source_text_returned: false,
        provider_cursor_exposed: false,
      });
      expect(JSON.stringify(changed.receipt)).not.toContain('/id:b.txt');
      expect(JSON.stringify(changed.receipt)).not.toContain('id:b.txt');
      expect(store.itemPresence(identityFor('id:a'))).toEqual({ active: true });
      expect(store.itemPresence(identityFor('id:b'))).toEqual({ active: false });

      const tail = await sync.pull({
        approved_scope_key: 'dropbox.personal:/',
        max_items: 2,
      });
      expect(tail.receipt.counts.items_seen).toBe(2);
      expect(tail.receipt.counts.page_digest_restarts).toBe(0);
      expect(tail.receipt.counts.traversal_complete).toBe(1);
      expect(store.itemPresence(identityFor('id:b'))).toEqual({ active: false });
      expect(store.itemPresence(identityFor('id:c'))).toEqual({ active: true });
      expect(store.itemPresence(identityFor('id:d'))).toEqual({ active: true });
    } finally {
      close();
    }
  });
});

function testStore(): { store: LocalConnectorStore; close(): void } {
  const store = storeAt(testStorePath());
  return { store, close: () => store.close() };
}

function testStorePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-dropbox-provider-store-'));
  roots.push(root);
  return join(root, 'store.sqlite');
}

function storeAt(dbPath: string): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath,
    corpusId: 'secure_local.dropbox.files',
    family: 'file',
    trustDomain: 'secure_local',
  });
}

/**
 * Reproduce the exact state the v11 migration leaves on a store that already
 * held items: the projection is empty and gated, and no operator pass has run.
 */
function rewindLocatorIdentityIndexToMigration(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      DELETE FROM item_locator_identities;
      UPDATE locator_identity_index_state
      SET cursor_item_pk = 0, completed = 0
      WHERE singleton = 1;
    `);
  } finally {
    db.close();
  }
}

function broker(): StaticCredentialBroker {
  return new StaticCredentialBroker([{
    handle: 'dropbox.personal',
    provider: 'dropbox',
    allowedCapabilities: ['dropbox.files.sync'],
    token: 'test-token',
    trustDomain: 'secure_local',
  }]);
}

function identity() {
  return identityFor('id:stable-file', 'rev-1');
}

function identityFor(providerItemId: string, sourceVersion?: string) {
  return {
    family: 'file' as const,
    provider: 'dropbox',
    accountScope: 'personal',
    providerItemId,
    providerFileId: providerItemId,
    localItemId: `personal:${providerItemId}`,
    ...(sourceVersion ? { sourceVersion } : {}),
  };
}

function file(id: string) {
  return {
    tag: 'file' as const,
    id,
    name: `${id}.txt`,
    pathDisplay: `/${id}.txt`,
  };
}
