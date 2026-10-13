import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  createDropboxProviderStoreSyncHandler,
  createDropboxSourceConnector,
  createDropboxTierLane,
  type DropboxMetadataClient,
  type DropboxMetadataEntry,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';
import { createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';

// A deleted Dropbox folder arrives as ONE entry for its whole subtree: the
// descendants' own paths are never listed. These tests pin that the entry is
// expanded into the descendants' deletions, through the ordinary deletion path.

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const SCOPE = 'dropbox.personal:/Approved';

/** The approved folder's tree: a folder with two nested levels, and look-alikes beside it. */
const TREE: DropboxMetadataEntry[] = [
  folder('id:docs', '/Approved/Docs'),
  file('id:a', '/Approved/Docs/a.txt'),
  folder('id:sub', '/Approved/Docs/Sub'),
  file('id:b', '/Approved/Docs/Sub/b.txt'),
  folder('id:deep', '/Approved/Docs/Sub/Deep'),
  file('id:c', '/Approved/Docs/Sub/Deep/c.txt'),
  // Share a name prefix with the folder, but are not under it.
  folder('id:docsold', '/Approved/DocsOld'),
  file('id:sibling', '/Approved/DocsOld/s.txt'),
  file('id:docs2', '/Approved/Docs2.txt'),
  file('id:dotted', '/Approved/Docs.txt'),
  file('id:keep', '/Approved/keep.txt'),
];
const UNDER_DOCS = ['id:docs', 'id:a', 'id:sub', 'id:b', 'id:deep', 'id:c'];
const BESIDE_DOCS = ['id:docsold', 'id:sibling', 'id:docs2', 'id:dotted', 'id:keep'];

describe('a deleted Dropbox folder takes its indexed descendants with it', () => {
  test('tombstones the folder and both nested levels below it, and nothing that only shares a name prefix', async () => {
    const { store, sync } = singleStoreLane({
      initial: TREE,
      deltas: { 'cursor-1': [deleted('Docs', '/Approved/Docs')] },
    });
    await sync.pull({ approved_scope_key: SCOPE });
    expectActive(store, [...UNDER_DOCS, ...BESIDE_DOCS]);

    const outcome = await sync.pull({ approved_scope_key: SCOPE });

    expectInactive(store, UNDER_DOCS);
    expectActive(store, BESIDE_DOCS);
    expect(outcome.receipt.counts).toMatchObject({
      items_tombstoned: UNDER_DOCS.length,
      deleted_events_applied: UNDER_DOCS.length,
      items_rejected: 0,
      traversal_complete: 1,
    });
    expect(outcome.receipt.warnings).toBeUndefined();
  });

  test('matches the path without regard to case, as Dropbox does', async () => {
    const { store, sync } = singleStoreLane({
      initial: TREE,
      // The event names the folder in the provider's lower case; the rows were
      // stored under the display path.
      deltas: { 'cursor-1': [{ tag: 'deleted', name: 'docs', pathLower: '/approved/docs' }] },
    });
    await sync.pull({ approved_scope_key: SCOPE });
    await sync.pull({ approved_scope_key: SCOPE });

    expectInactive(store, UNDER_DOCS);
    expectActive(store, BESIDE_DOCS);

    const shouting = singleStoreLane({
      initial: TREE,
      deltas: { 'cursor-1': [{ tag: 'deleted', name: 'DOCS', pathDisplay: '/APPROVED/DOCS' }] },
    });
    await shouting.sync.pull({ approved_scope_key: SCOPE });
    await shouting.sync.pull({ approved_scope_key: SCOPE });
    expectInactive(shouting.store, UNDER_DOCS);
    expectActive(shouting.store, BESIDE_DOCS);
  });

  test('in the approved-scope lane the subtree goes the same way', async () => {
    const root = workspace();
    const store = laneStore(join(root, 'store.sqlite'));
    const sync = createDropboxProviderStoreSyncHandler({
      store,
      account: 'personal',
      broker: broker(),
      metadataClient: client({ initial: TREE, deltas: { 'cursor-1': [deleted('Docs', '/Approved/Docs')] } }),
      scope: fakeScope((path) => path.startsWith('/approved')),
    });
    await sync.pull({ approved_scope_key: SCOPE });
    expectActive(store, [...UNDER_DOCS, ...BESIDE_DOCS]);
    const outcome = await sync.pull({ approved_scope_key: SCOPE });

    expectInactive(store, UNDER_DOCS);
    expectActive(store, BESIDE_DOCS);
    expect(outcome.receipt.counts).toMatchObject({ items_tombstoned: UNDER_DOCS.length, items_rejected: 0 });
  });

  test('a single deleted file still removes just that file', async () => {
    const { store, sync } = singleStoreLane({
      initial: TREE,
      deltas: { 'cursor-1': [deleted('b.txt', '/Approved/Docs/Sub/b.txt')] },
    });
    await sync.pull({ approved_scope_key: SCOPE });
    const outcome = await sync.pull({ approved_scope_key: SCOPE });

    expectInactive(store, ['id:b']);
    expectActive(store, [...UNDER_DOCS.filter((id) => id !== 'id:b'), ...BESIDE_DOCS]);
    expect(outcome.receipt.counts).toMatchObject({ items_tombstoned: 1, deleted_events_applied: 1, items_rejected: 0 });
  });

  test('the same folder event delivered again deletes nothing twice', async () => {
    const { store, sync } = singleStoreLane({
      initial: TREE,
      deltas: {
        'cursor-1': [deleted('Docs', '/Approved/Docs')],
        'cursor-2': [deleted('Docs', '/Approved/Docs')],
      },
    });
    await sync.pull({ approved_scope_key: SCOPE });
    await sync.pull({ approved_scope_key: SCOPE });
    const again = await sync.pull({ approved_scope_key: SCOPE });

    expectInactive(store, UNDER_DOCS);
    expectActive(store, BESIDE_DOCS);
    // Nothing active is left under the path to expand into.
    expect(again.receipt.counts.items_tombstoned).toBe(0);
    expect(again.receipt.counts.deleted_events_applied).toBe(0);
  });

  test('never reaches another account\'s rows at the same path', async () => {
    const root = workspace();
    const store = laneStore(join(root, 'store.sqlite'));
    const personal = handler(store, 'personal', client({
      initial: TREE,
      deltas: { 'cursor-1': [deleted('Docs', '/Approved/Docs')] },
    }));
    const work = handler(store, 'work', client({
      initial: TREE.map((entry) => (entry.tag === 'deleted' ? entry : { ...entry, id: `work:${entry.id}` })),
      deltas: {},
    }));
    await personal.pull({ approved_scope_key: SCOPE });
    await work.pull({ approved_scope_key: 'dropbox.work:/Approved' });
    await personal.pull({ approved_scope_key: SCOPE });

    expectInactive(store, UNDER_DOCS);
    for (const id of UNDER_DOCS) {
      expect(store.itemPresence(identityFor(`work:${id}`, 'work')).active).toBe(true);
    }
  });

  test('a folder whose subtree is larger than one pass converges over bounded passes, folder last', async () => {
    const many = Array.from({ length: 7 }, (_, index) => file(`id:many-${index}`, `/Approved/Big/${index}.txt`));
    const { store, sync, calls } = singleStoreLane({
      initial: [folder('id:big', '/Approved/Big'), ...many, file('id:after', '/Approved/after.txt')],
      deltas: {
        'cursor-1': [deleted('Big', '/Approved/Big'), file('id:late', '/Approved/late.txt')],
      },
    });
    await sync.pull({ approved_scope_key: SCOPE });
    const bigIds = ['id:big', ...many.map((entry) => (entry as { id: string }).id)];
    expectActive(store, bigIds);

    const seen: number[] = [];
    const warnings: string[] = [];
    let passes = 0;
    while (store.itemPresence(identityFor('id:late')).active === false && passes < 10) {
      const outcome = await sync.pull({ approved_scope_key: SCOPE, max_items: 3 });
      seen.push(outcome.receipt.counts.items_seen);
      warnings.push(...(outcome.receipt.warnings ?? []));
      passes += 1;
    }

    expectInactive(store, bigIds);
    expectActive(store, ['id:after', 'id:late']);
    // Never more than the pass budget, and never an abandoned page.
    expect(seen.every((count) => count <= 3)).toBe(true);
    expect(warnings.filter((warning) => warning.startsWith('connector_page_abandoned'))).toEqual([]);
    expect(passes).toBeGreaterThan(1);
    expect(calls.filter((call) => call === 'list')).toHaveLength(1);
  });

  test('a fresh traversal whose first entry is a folder larger than the pass budget resumes from the start', async () => {
    const root = workspace();
    const store = laneStore(join(root, 'store.sqlite'));
    // The tree is indexed by one approved root; a second root's fresh listing
    // then reports the folder's deletion as its very first entry.
    await handler(store, 'personal', client({ initial: TREE })).pull({ approved_scope_key: SCOPE });
    const wholeAccount = handler(store, 'personal', client({
      initial: [deleted('Docs', '/Approved/Docs'), file('id:late', '/late.txt')],
    }));

    let passes = 0;
    const checkpoints: Array<string | null> = [];
    while (store.itemPresence(identityFor('id:late')).active === false && passes < 10) {
      const outcome = await wholeAccount.pull({ approved_scope_key: 'dropbox.personal:/', max_items: 3 });
      expect(outcome.receipt.counts.items_seen).toBeLessThanOrEqual(3);
      checkpoints.push(outcome.checkpoint);
      passes += 1;
    }

    expectInactive(store, UNDER_DOCS);
    expectActive(store, [...BESIDE_DOCS, 'id:late']);
    expect(passes).toBeGreaterThan(1);
    // Until the folder is fully gone there is no provider position to keep.
    expect(checkpoints[0]).toBeNull();
  });

  describe('a folder that was moved or renamed is not deleted', () => {
    const moved = [
      folder('id:new', '/Approved/Renamed'),
      file('id:a', '/Approved/Renamed/a.txt'),
      file('id:b', '/Approved/Renamed/Sub/b.txt'),
    ];
    const gone = deleted('Docs', '/Approved/Docs');

    for (const [label, delta] of [
      ['delete first', [gone, ...moved]],
      ['delete last', [...moved, gone]],
    ] as const) {
      test(`keeps files re-listed at the new path, whatever the order (${label}); removes what was not re-listed`, async () => {
        const { store, sync } = singleStoreLane({ initial: TREE, deltas: { 'cursor-1': [...delta] } });
        await sync.pull({ approved_scope_key: SCOPE });
        await sync.pull({ approved_scope_key: SCOPE });

        expectActive(store, ['id:a', 'id:b', ...BESIDE_DOCS]);
        expect(store.activeIdentityForLocatorIfIndexed({
          provider: 'dropbox',
          accountScope: 'personal',
          locatorUri: '/Approved/Renamed/a.txt',
        })?.providerItemId).toBe('id:a');
        // Not re-listed anywhere: really gone.
        expectInactive(store, ['id:c', 'id:sub', 'id:deep', 'id:docs']);
      });
    }

    const crossPage: Script = {
      initial: TREE,
      deltaPages: {
        'cursor-1': { entries: [gone], cursor: 'cursor-2', hasMore: true },
        'cursor-2': { entries: moved, cursor: 'cursor-3', hasMore: false },
      },
    };

    test('a file re-listed on a later page keeps its indexed text, and what was not re-listed loses it', async () => {
      const { store, sync, calls } = singleStoreLane(crossPage);
      await sync.pull({ approved_scope_key: SCOPE });
      for (const id of ['id:a', 'id:b', 'id:c']) expect((await landText(store, id, `The pelican of ${id} nests here.`)).accepted).toBe(true);
      expect(store.searchItems('pelican', 10).map((row) => row.sourceItem.providerItemId).sort()).toEqual(['id:a', 'id:b', 'id:c']);

      const outcome = await sync.pull({ approved_scope_key: SCOPE });

      // The pass looked past the folder's page, saw the move, and never took the files down.
      expect(calls).toContain('continue:cursor-2');
      expect(outcome.receipt.counts.traversal_complete).toBe(1);
      expectActive(store, ['id:a', 'id:b']);
      expectInactive(store, ['id:c', 'id:sub', 'id:deep', 'id:docs']);
      expect(store.searchItems('pelican', 10).map((row) => row.sourceItem.providerItemId).sort()).toEqual(['id:a', 'id:b']);
    });

    test('when the later pages cannot be read ahead, the folder\'s page still ends the pass, and the move restores the files on the next', async () => {
      const root = workspace();
      const store = laneStore(join(root, 'store.sqlite'));
      const base = client(crossPage);
      let readAheadFails = true;
      const flaky: DropboxMetadataClient = {
        ...base,
        async listFolderContinue(request) {
          if (request.cursor === 'cursor-2' && readAheadFails) {
            readAheadFails = false;
            throw new Error('transient');
          }
          return base.listFolderContinue(request);
        },
      };
      const sync = handler(store, 'personal', flaky);
      await sync.pull({ approved_scope_key: SCOPE });

      const first = await sync.pull({ approved_scope_key: SCOPE });
      // Without the look-ahead the delete is applied as before and the pass ends with its page...
      expect(first.receipt.counts.traversal_complete).toBe(0);
      expectInactive(store, ['id:a', 'id:b', 'id:c']);

      // ...so the next page's re-add is not overruled, and the files come back.
      const second = await sync.pull({ approved_scope_key: SCOPE });
      expect(second.receipt.counts.traversal_complete).toBe(1);
      expectActive(store, ['id:a', 'id:b']);
      expectInactive(store, ['id:c']);
    });
  });

  test('a resolver that cannot list a subtree still applies the folder\'s own deletion, as before', async () => {
    const { store, sync } = singleStoreLane({
      initial: TREE,
      deltas: { 'cursor-1': [deleted('Docs', '/Approved/Docs')] },
    });
    await sync.pull({ approved_scope_key: SCOPE });

    const connector = createDropboxSourceConnector({
      account: 'personal',
      approvedScopeKey: SCOPE,
      broker: broker(),
      deletedItemIdentityResolver: {
        activeIdentityForLocatorIfIndexed: (input) => store.activeIdentityForLocatorIfIndexed(input),
      },
      metadataClient: client({ initial: [deleted('Docs', '/Approved/Docs')], deltas: {} }),
    });
    const items = [];
    for await (const page of connector.listItems()) items.push(...page.items);
    expect(items.map((item) => item.identity.providerItemId)).toEqual(['id:docs']);
  });

  test('a deleted folder outside the approved scope is not this lane\'s event and is never expanded', async () => {
    const lookups: string[] = [];
    const connector = createDropboxSourceConnector({
      account: 'personal',
      approvedScopeKey: SCOPE,
      broker: broker(),
      scope: fakeScope((path) => path.startsWith('/approved')),
      deletedItemIdentityResolver: {
        activeIdentityForLocatorIfIndexed: () => undefined,
        activeItemsUnderLocatorIfIndexed: (input) => {
          lookups.push(input.locatorUri);
          return [];
        },
      },
      metadataClient: client({ initial: [deleted('Docs', '/Elsewhere/Docs')], deltas: {} }),
    });
    const items = [];
    for await (const page of connector.listItems()) items.push(...page.items);
    expect(items).toEqual([]);
    expect(lookups).toEqual([]);
  });

  test('an unrooted or empty deleted path expands to nothing', async () => {
    const lookups: string[] = [];
    const connector = createDropboxSourceConnector({
      account: 'personal',
      approvedScopeKey: SCOPE,
      broker: broker(),
      deletedItemIdentityResolver: {
        activeIdentityForLocatorIfIndexed: () => undefined,
        activeItemsUnderLocatorIfIndexed: (input) => {
          lookups.push(input.locatorUri);
          return [];
        },
      },
      metadataClient: client({
        initial: [
          { tag: 'deleted', name: 'id:x', pathDisplay: 'id:x' },
          { tag: 'deleted', name: 'root', pathDisplay: '/' },
          { tag: 'deleted', name: 'Docs', pathDisplay: '/Approved/Docs/', pathLower: '/approved/docs' },
        ],
        deltas: {},
      }),
    });
    for await (const page of connector.listItems()) void page;
    // The root is never a folder that was deleted; a trailing slash and the
    // lower-cased twin collapse to one lookup of the path itself.
    expect(lookups).toEqual(['/Approved/Docs']);
  });
});

describe('a deleted folder with a non-ASCII name', () => {
  test('is matched without regard to case or accent composition, and takes its descendants with it', async () => {
    const decomposed = 'Cafe\u0301';
    const { store, sync } = singleStoreLane({
      initial: [
        folder('id:school', '/Approved/\u00c9cole'),
        file('id:s1', '/Approved/\u00c9cole/a.txt'),
        file('id:s2', '/Approved/\u00c9cole/Sub/b.txt'),
        file('id:ecole', '/Approved/Ecole/c.txt'),
        folder('id:cafe', `/Approved/${decomposed}`),
        file('id:k1', `/Approved/${decomposed}/m.txt`),
      ],
      deltas: {
        'cursor-1': [
          // Dropbox lower-cases the whole path, accents included.
          { tag: 'deleted', name: '\u00c9cole', pathDisplay: '/Approved/\u00c9cole', pathLower: '/approved/\u00e9cole' },
          // And may spell the accent composed where the index stored it decomposed.
          { tag: 'deleted', name: 'Caf\u00e9', pathDisplay: '/Approved/Caf\u00e9', pathLower: '/approved/caf\u00e9' },
        ],
      },
    });
    await sync.pull({ approved_scope_key: SCOPE });
    expectActive(store, ['id:school', 'id:s1', 'id:s2', 'id:ecole', 'id:cafe', 'id:k1']);

    await sync.pull({ approved_scope_key: SCOPE });

    expectInactive(store, ['id:school', 'id:s1', 'id:s2', 'id:k1']);
    // The unaccented twin is a different folder.
    expectActive(store, ['id:ecole']);
  });
});

describe('LocalConnectorStore.activeItemsUnderLocatorIfIndexed', () => {
  const under = (store: LocalConnectorStore, locatorUri: string, limit = 100) => store
    .activeItemsUnderLocatorIfIndexed({ provider: 'dropbox', accountScope: 'personal', locatorUri, limit })
    .map((row) => row.identity.providerItemId)
    .sort();

  async function indexedTree(dbPath = join(workspace(), 'store.sqlite')) {
    const store = laneStore(dbPath);
    await handler(store, 'personal', client({ initial: TREE })).pull({ approved_scope_key: SCOPE });
    return { store, dbPath };
  }

  test('lists everything strictly below the path, whatever its case or trailing slash, and nothing beside it', async () => {
    const { store } = await indexedTree();
    const below = ['id:a', 'id:b', 'id:c', 'id:deep', 'id:sub'];

    expect(under(store, '/Approved/Docs')).toEqual(below);
    expect(under(store, '/approved/docs')).toEqual(below);
    expect(under(store, '/APPROVED/DOCS/')).toEqual(below);
    expect(under(store, '/Approved/Docs/Sub')).toEqual(['id:b', 'id:c', 'id:deep']);
    // The path's own row, a leaf, and look-alike names are not below it.
    expect(under(store, '/Approved/Docs/a.txt')).toEqual([]);
    expect(under(store, '/Approved/Doc')).toEqual([]);
    expect(under(store, '/Approved/Docs.txt')).toEqual([]);
    expect(under(store, '/Approved/DocsOld')).toEqual(['id:sibling']);
  });

  test('returns the stored locator beside each identity, and honours the limit and the account', async () => {
    const { store } = await indexedTree();
    const rows = store.activeItemsUnderLocatorIfIndexed({
      provider: 'dropbox',
      accountScope: 'personal',
      locatorUri: '/Approved/Docs/Sub',
      limit: 2,
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.locatorUri.startsWith('/Approved/Docs/Sub/')).toBe(true);
      expect(row.identity).toMatchObject({ provider: 'dropbox', accountScope: 'personal', family: 'file' });
      expect(row.identity.localItemId).toBe(`personal:${row.identity.providerItemId}`);
    }
    expect(store.activeItemsUnderLocatorIfIndexed({
      provider: 'dropbox', accountScope: 'someone-else', locatorUri: '/Approved/Docs', limit: 100,
    })).toEqual([]);
    expect(store.activeItemsUnderLocatorIfIndexed({
      provider: 'other', accountScope: 'personal', locatorUri: '/Approved/Docs', limit: 100,
    })).toEqual([]);
  });

  test('never reads the root or an unusable limit as a request to list the account', async () => {
    const { store } = await indexedTree();
    expect(under(store, '/')).toEqual([]);
    expect(under(store, '')).toEqual([]);
    expect(under(store, '/Approved/Docs', 0)).toEqual([]);
    expect(under(store, '/Approved/Docs', -1)).toEqual([]);
    expect(under(store, '/Approved/Docs', 1.5)).toEqual([]);
  });

  test('matches non-ASCII folders by their folded form: case, and composed or decomposed accents', async () => {
    const store = laneStore(join(workspace(), 'store.sqlite'));
    const decomposed = 'Cafe\u0301';
    await handler(store, 'personal', client({
      initial: [
        file('id:e1', '/Approved/\u00c9cole/a.txt'),
        file('id:e2', '/Approved/\u00c9cole/Sub/b.txt'),
        // Not under the folder: another name, an unaccented twin, a longer name.
        file('id:e3', '/Approved/Ecole/c.txt'),
        file('id:e4', '/Approved/\u00c9coleNord/d.txt'),
        file('id:e5', '/Approved/\u00c9cole.txt'),
        // Stored decomposed.
        file('id:c1', `/Approved/${decomposed}/m.txt`),
        // Under an ASCII folder with a non-ASCII child folder.
        file('id:z1', '/Approved/Docs/\u00dcber/z.txt'),
      ],
    })).pull({ approved_scope_key: SCOPE });

    // SQLite's LOWER() leaves \u00c9 alone, so an upper-cased stored name only matches by folding in full.
    expect(under(store, '/Approved/\u00c9cole')).toEqual(['id:e1', 'id:e2']);
    expect(under(store, '/approved/\u00e9cole')).toEqual(['id:e1', 'id:e2']);
    expect(under(store, '/APPROVED/\u00c9COLE/')).toEqual(['id:e1', 'id:e2']);
    expect(under(store, '/approved/\u00e9cole/sub')).toEqual(['id:e2']);
    // Composed and decomposed spellings of one name are one folder.
    expect(under(store, '/Approved/Caf\u00e9')).toEqual(['id:c1']);
    expect(under(store, '/approved/caf\u00e9')).toEqual(['id:c1']);
    expect(under(store, `/approved/${decomposed}`)).toEqual(['id:c1']);
    expect(under(store, '/Approved/Docs/\u00fcber')).toEqual(['id:z1']);
    // Look-alikes stay out, and the limit still holds on the slow path.
    expect(under(store, '/Approved/Ecole')).toEqual(['id:e3']);
    expect(under(store, '/Approved/\u00c9cole', 1)).toHaveLength(1);
    expect(under(store, '/Approved/\u00c9col')).toEqual([]);
  });

  test('skips tombstoned rows', async () => {
    const { store } = await indexedTree();
    await handler(store, 'personal', client({
      initial: TREE,
      deltas: { 'cursor-1': [deleted('b.txt', '/Approved/Docs/Sub/b.txt')] },
    })).pull({ approved_scope_key: SCOPE });
    expect(under(store, '/Approved/Docs/Sub')).toEqual(['id:c', 'id:deep']);
  });

  test('answers with nothing, rather than throwing, while the locator index is still converging', async () => {
    const { store, dbPath } = await indexedTree();
    store.close();
    const db = new Database(dbPath);
    try {
      db.exec(`
        DELETE FROM item_locator_identities;
        UPDATE locator_identity_index_state SET cursor_item_pk = 0, completed = 0 WHERE singleton = 1;
      `);
    } finally {
      db.close();
    }
    const upgraded = laneStore(dbPath);
    expect(under(upgraded, '/Approved/Docs')).toEqual([]);
  });
});

describe('a deleted folder through the per-tier stores', () => {
  const NEW_PDFS = [
    file('id:new-top', '/Approved/Docs/new-top.pdf'),
    file('id:new-deep', '/Approved/Docs/Sub/new-deep.pdf'),
    file('id:new-sibling', '/Approved/DocsOld/new-sibling.pdf'),
    // Under an owner "published" folder: names and text are Public.
    file('id:new-pub', '/Approved/Docs/Published/essay.pdf'),
  ];

  /** Legacy files in the lane's one secure store, then routed files whose names and text land by tier. */
  async function tierFixture() {
    const root = workspace();
    const env = {
      OLYMPUS_SOURCE_INDEX_DROPBOX_INTERNAL_CONNECTOR_STORE_DB_PATH: join(root, 'dropbox-internal.sqlite'),
      OLYMPUS_SOURCE_INDEX_DROPBOX_PUBLIC_CONNECTOR_STORE_DB_PATH: join(root, 'dropbox-public.sqlite'),
      OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: join(root, 'no-exclusions.json'),
    };
    const metadataClient = client({
      initial: TREE,
      deltas: {
        'cursor-1': NEW_PDFS,
        'cursor-2': [deleted('Docs', '/Approved/Docs')],
      },
    });
    const secure = laneStore(join(root, 'dropbox-secure.sqlite'));
    // Before per-item routing: the lane's one secure store holds the tree.
    await handler(secure, 'personal', metadataClient).pull({ approved_scope_key: SCOPE });

    const secrets = new SecretLocationsIndex({ dbPath: join(root, 'secrets.sqlite') });
    closers.push(() => secrets.close());
    const lane = createDropboxTierLane({
      secureStore: secure,
      env,
      policy: defaultDropboxIngestionPolicy(),
      secretLocations: secrets,
      tierClassification: {
        rules: [{ id: 'published', match: { kind: 'pathPrefix', value: '/Approved/Docs/Published' }, tier: 'public', strength: 'prior' }],
      },
    });
    closers.push(() => {
      lane.internal.current()?.close();
      lane.public.current()?.close();
    });
    const sync = createDropboxProviderStoreSyncHandler({
      store: secure,
      account: 'personal',
      broker: broker(),
      metadataClient,
      tierSet: lane.set,
    });
    // New files are routed: their names go to the Personal store; text lands by its own tier.
    await sync.pull({ approved_scope_key: SCOPE });
    const internal = lane.internal.current()!;
    expect(internal).toBeDefined();
    const sink = createTieredStoreExtractionSink({ set: lane.set, syncConnectorId: 'extraction', ownerConnectorId: 'dropbox', ownershipKind: 'observed' });
    const land = (id: string, text: string) => sink.accept({
      ref: {
        corpusId: 'secure_local.dropbox.files',
        provider: 'dropbox',
        accountScope: 'personal',
        approvedScopeKey: SCOPE,
        providerItemId: id,
        localItemId: `personal:${id}`,
        sourceVersion: 'r1',
      },
      text,
      extractorKind: 'local_text',
      extractorVersion: 'test',
      fetchedAt: '2026-10-13T00:00:00.000Z',
    });
    // One routed file keeps names in Personal and its Private text in Private;
    // another keeps both in Personal; the sibling is Personal too.
    expect((await land('id:new-top', 'The lab results confirm the diagnosis; treatment starts Monday.')).accepted).toBe(true);
    expect((await land('id:new-deep', 'Chapter three covers the history of cartography.')).accepted).toBe(true);
    expect((await land('id:new-sibling', 'Chapter four covers the history of lighthouses.')).accepted).toBe(true);
    expect((await land('id:new-pub', 'An essay on heirloom tomatoes, published on the owner site.')).accepted).toBe(true);
    const publicStore = lane.public.current()!;
    expect(publicStore).toBeDefined();
    expect(publicStore.searchItems('tomatoes', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['id:new-pub']);
    expect(copiesIn(lane, identityFor('id:new-top')).length).toBeGreaterThan(1);
    expect(lane.ledger.isRouted(identityFor('id:new-top'))).toBe(true);
    expect(secure.searchItems('diagnosis', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['id:new-top']);
    expect(internal.searchItems('cartography', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['id:new-deep']);
    return { root, lane, sync, secure, internal, publicStore };
  }

  function expectFolderGone(fixture: Awaited<ReturnType<typeof tierFixture>>): void {
    const { lane, secure, internal, publicStore } = fixture;
    // Gone from every store the item had a copy in: legacy rows, routed names, routed text.
    for (const providerItemId of [...UNDER_DOCS, 'id:new-top', 'id:new-deep', 'id:new-pub']) {
      for (const store of [secure, internal, publicStore]) {
        expect([providerItemId, store.itemPresence(identityFor(providerItemId)).active]).toEqual([providerItemId, false]);
      }
    }
    expect(secure.searchItems('diagnosis', 10)).toEqual([]);
    expect(internal.searchItems('diagnosis', 10)).toEqual([]);
    expect(internal.searchItems('cartography', 10)).toEqual([]);
    expect(secure.searchItems('cartography', 10)).toEqual([]);
    expect(publicStore.searchItems('tomatoes', 10)).toEqual([]);
    // The ledger forgot the routed items' copies, as for a single-file delete
    // (the item stays "routed", so a reappearance is routed afresh).
    for (const providerItemId of ['id:new-top', 'id:new-deep', 'id:new-pub']) {
      expect(copiesIn(lane, identityFor(providerItemId))).toEqual([]);
    }
    // The look-alikes beside the folder are untouched, in the stores that hold them.
    for (const providerItemId of BESIDE_DOCS) expect(secure.itemPresence(identityFor(providerItemId)).active).toBe(true);
    expect(internal.itemPresence(identityFor('id:new-sibling')).active).toBe(true);
    expect(internal.searchItems('lighthouses', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['id:new-sibling']);
    expect(copiesIn(lane, identityFor('id:new-sibling')).length).toBeGreaterThan(0);
  }

  test('removes legacy and routed descendants from every store that holds a copy, and clears the ledger', async () => {
    const fixture = await tierFixture();
    const outcome = await fixture.sync.pull({ approved_scope_key: SCOPE });

    expectFolderGone(fixture);
    expect(outcome.receipt.counts.items_rejected).toBe(0);
    expect(outcome.receipt.counts.deleted_events_applied).toBeGreaterThanOrEqual(UNDER_DOCS.length + 3);
  });

  test('a tier store still building its locator index holds the folder event for a pass instead of losing it', async () => {
    const fixture = await tierFixture();
    // The Personal store as an upgrade leaves it: projection empty and gated.
    const db = new Database(join(fixture.root, 'dropbox-internal.sqlite'));
    try {
      db.exec(`
        DELETE FROM item_locator_identities;
        UPDATE locator_identity_index_state SET cursor_item_pk = 0, completed = 0 WHERE singleton = 1;
      `);
    } finally {
      db.close();
    }
    expect(fixture.internal.locatorIdentityIndexReady()).toBe(false);

    const held = await fixture.sync.pull({ approved_scope_key: SCOPE });
    // The event was not consumed: its routed descendants are still there and the cursor has not passed it.
    expect(held.receipt.counts.traversal_complete).toBe(0);
    expect(fixture.internal.itemPresence(identityFor('id:new-deep')).active).toBe(true);
    expect(fixture.internal.searchItems('cartography', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['id:new-deep']);
    // That pass's own leg converged the store.
    expect(fixture.internal.locatorIdentityIndexReady()).toBe(true);

    const applied = await fixture.sync.pull({ approved_scope_key: SCOPE });
    expect(applied.receipt.counts.traversal_complete).toBe(1);
    expectFolderGone(fixture);
  });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-dropbox-folder-delete-'));
  roots.push(root);
  return root;
}

function laneStore(dbPath: string): LocalConnectorStore {
  const store = new LocalConnectorStore({
    dbPath,
    corpusId: 'secure_local.dropbox.files',
    family: 'file',
    trustDomain: 'secure_local',
  });
  closers.push(() => store.close());
  return store;
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

function handler(store: LocalConnectorStore, account: string, metadataClient: DropboxMetadataClient) {
  return createDropboxProviderStoreSyncHandler({ store, account, broker: broker(), metadataClient });
}

interface Script {
  initial: DropboxMetadataEntry[];
  /** Entries the provider reports for `continue` from a cursor; the next cursor is `cursor-N+1`. */
  deltas?: Record<string, DropboxMetadataEntry[]>;
  /** Or whole pages, to script paging. */
  deltaPages?: Record<string, DropboxMetadataPage>;
}

function client(script: Script, calls: string[] = []): DropboxMetadataClient {
  return {
    supportsNativeRecursive: true,
    async listFolder(): Promise<DropboxMetadataPage> {
      calls.push('list');
      return { entries: script.initial, cursor: 'cursor-1', hasMore: false };
    },
    async listFolderContinue(request): Promise<DropboxMetadataPage> {
      calls.push(`continue:${request.cursor}`);
      const page = script.deltaPages?.[request.cursor];
      if (page) return page;
      const entries = script.deltas?.[request.cursor] ?? [];
      const next = Number(request.cursor.replace('cursor-', '')) + 1;
      return { entries, cursor: `cursor-${next}`, hasMore: false };
    },
  };
}

function singleStoreLane(script: Script) {
  const root = workspace();
  const store = laneStore(join(root, 'store.sqlite'));
  const calls: string[] = [];
  const sync = handler(store, 'personal', client(script, calls));
  return { store, sync, calls };
}

/** Lands extracted text on an item of the lane's one store, as the extraction runner does. */
function landText(store: LocalConnectorStore, providerItemId: string, text: string) {
  return createConnectorStoreExtractionSink({
    store,
    classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
    syncConnectorId: 'extraction',
    ownerConnectorId: 'dropbox',
    ownershipKind: 'observed',
  }).accept({
    ref: {
      corpusId: 'secure_local.dropbox.files',
      provider: 'dropbox',
      accountScope: 'personal',
      approvedScopeKey: SCOPE,
      providerItemId,
      localItemId: `personal:${providerItemId}`,
      sourceVersion: 'r1',
    },
    text,
    extractorKind: 'local_text',
    extractorVersion: 'test',
    fetchedAt: '2026-10-13T00:00:00.000Z',
  });
}

function fakeScope(allows: (lowerPath: string) => boolean) {
  return {
    generation: 'a'.repeat(64),
    revision: '11111111-1111-4111-8111-111111111111',
    allowsMetadata: allows,
    allowsContent: allows,
    assertCurrent() {},
  };
}

function copiesIn(lane: ReturnType<typeof createDropboxTierLane>, identity: ReturnType<typeof identityFor>) {
  return lane.ledger.copies(identity);
}

function identityFor(providerItemId: string, accountScope = 'personal') {
  return { family: 'file' as const, provider: 'dropbox', accountScope, providerItemId, localItemId: `${accountScope}:${providerItemId}` };
}

function expectActive(store: LocalConnectorStore, ids: readonly string[]): void {
  for (const id of ids) expect([id, store.itemPresence(identityFor(id)).active]).toEqual([id, true]);
}

function expectInactive(store: LocalConnectorStore, ids: readonly string[]): void {
  for (const id of ids) expect([id, store.itemPresence(identityFor(id)).active]).toEqual([id, false]);
}

function folder(id: string, path: string): DropboxMetadataEntry {
  return { tag: 'folder', id, name: path.slice(path.lastIndexOf('/') + 1), pathDisplay: path, pathLower: path.toLowerCase() };
}

function file(id: string, path: string): DropboxMetadataEntry {
  return {
    tag: 'file',
    id,
    name: path.slice(path.lastIndexOf('/') + 1),
    pathDisplay: path,
    pathLower: path.toLowerCase(),
    rev: 'r1',
  };
}

/** Dropbox reports a deletion by path alone: no id, no children. */
function deleted(name: string, path: string): DropboxMetadataEntry {
  return { tag: 'deleted', name, pathDisplay: path, pathLower: path.toLowerCase() };
}
