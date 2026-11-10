// Child items add four nullable columns and one index to the connector
// store's `items` table (schema v15, docs/design/child-items.md, "Storage") and
// change NOTHING about what an existing row, chunk or vector holds. A store
// from before them must end the migration byte-identical in every table it
// already had, with the new columns empty, and must not re-embed.
//
// The same file proves what the columns are for: a child is stored with its
// parent link, its locator, its availability and its stated size; the
// extraction candidate query projects them and never offers a child the source
// says has no bytes; a locator is read back only for the version it was
// written for; and a tier move keeps all four.

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { ARCHIVE_STORE_PLACEMENT } from '../src/workers/archive-import/store.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import {
  childProviderItemId,
  createFixtureChildConnector,
  fixtureLocalItemId,
  fixtureLocator,
  type FixtureParentSpec,
} from './helpers/child-items-fixture.ts';

const ACCOUNT = 'archive-1';
const PROVIDER = 'fixture-archive';

const PARENTS: FixtureParentSpec[] = [
  {
    id: 'msg-1',
    subject: 'Flat',
    sender: 'Alice',
    sentAt: '2024-03-03T10:00:00.000Z',
    body: 'Please find the lease attached.',
    children: [
      { key: 'p1', name: 'lease.pdf', mimeType: 'application/pdf', text: 'The lease term is thirty-seven months.' },
      { key: 'p2', name: 'missing.jpg', mimeType: 'image/jpeg', text: 'x', available: false },
    ],
  },
  { id: 'msg-2', subject: 'Garden', sender: 'Bo', sentAt: '2024-03-04T10:00:00.000Z', body: 'Weekly notes about the compost bins.', children: [] },
];

let embedCalls = 0;
const provider: SourceEmbeddingProvider = {
  provider: 'fixture',
  modelId: 'child-items-fixture-model',
  dimension: 4,
  configHash: 'child-items',
  epochId: 'epoch:child-items',
  backend: 'local',
  async embed(inputs: SourceEmbeddingInput[]) {
    embedCalls += inputs.length;
    return inputs.map((input) => [input.text.length % 7, input.text.length % 11, input.text.length % 13, 1]);
  },
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-child-items-store-'));
  dirs.push(dir);
  return dir;
}

function openStore(dbPath: string, corpusId = 'secure_local.archive.email', trustDomain: 'secure_local' | 'internal' = 'secure_local'): LocalConnectorStore {
  return new LocalConnectorStore({ dbPath, corpusId, family: 'email', trustDomain, tierLedger: null });
}

function connector(parents: readonly FixtureParentSpec[] = PARENTS): SourceConnector {
  return createFixtureChildConnector({ accountScope: ACCOUNT, provider: PROVIDER, parents, pageSize: 2 });
}

async function sync(store: LocalConnectorStore, source: SourceConnector = connector()): Promise<void> {
  await store.syncFromConnector(source, {
    fetchContent: true,
    deferMetadataOnlyContent: true,
    placement: ARCHIVE_STORE_PLACEMENT,
  });
}

function snapshot(dbPath: string): { items: unknown[]; chunks: unknown[]; vectors: unknown[]; fts: unknown[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      items: db.query(`
        SELECT local_item_id, provider_item_id, source_version, trust_tier, tombstoned, content_hash, title, search_text, mime_type
        FROM items ORDER BY local_item_id
      `).all(),
      chunks: db.query(`
        SELECT i.local_item_id, c.chunk_index, c.content_hash, c.bounded_text
        FROM chunks c JOIN items i ON i.item_pk = c.item_pk
        ORDER BY i.local_item_id, c.chunk_index
      `).all(),
      vectors: db.query(`
        SELECT i.local_item_id, c.chunk_index, e.model_id, e.content_hash, hex(e.embedding) AS bytes
        FROM chunk_embeddings e
        JOIN chunks c ON c.chunk_pk = e.chunk_pk
        JOIN items i ON i.item_pk = e.item_pk
        ORDER BY i.local_item_id, c.chunk_index
      `).all(),
      fts: db.query('SELECT rowid, * FROM connector_store_fts ORDER BY rowid').all(),
    };
  } finally {
    db.close();
  }
}

function rewindToV14(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      DROP INDEX IF EXISTS idx_connector_store_items_parent;
      ALTER TABLE items DROP COLUMN parent_local_item_id;
      ALTER TABLE items DROP COLUMN deferred_locator;
      ALTER TABLE items DROP COLUMN bytes_available;
      ALTER TABLE items DROP COLUMN size_bytes;
      UPDATE schema_version SET version = 14 WHERE store_id = 'connector-store';
    `);
  } finally {
    db.close();
  }
}

function childColumns(dbPath: string, localItemId: string): Record<string, unknown> | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(`
      SELECT parent_local_item_id, deferred_locator, bytes_available, size_bytes, source_version, tombstoned
      FROM items WHERE local_item_id = ?
    `).get(localItemId) as Record<string, unknown> | null;
  } finally {
    db.close();
  }
}

const identityOf = (providerItemId: string) => ({ provider: PROVIDER, accountScope: ACCOUNT, providerItemId });

describe('child items: the v15 migration changes nothing that exists', () => {
  test('a store from before the columns ends byte-identical, with the new columns empty, and never re-embeds', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'store.sqlite');
    // Only items with no children: what a store from before child items holds.
    const legacyParents = PARENTS.map((parent) => ({ ...parent, children: [] }));
    const legacy = openStore(dbPath);
    await sync(legacy, connector(legacyParents));
    await legacy.embedChunks({ provider });
    legacy.close();
    rewindToV14(dbPath);
    const before = snapshot(dbPath);
    expect(before.vectors.length).toBeGreaterThan(0);

    const invalidate = spyOn(
      LocalConnectorStore.prototype as unknown as { invalidateEmbeddingModelCurrency(modelId: string): void },
      'invalidateEmbeddingModelCurrency',
    );
    try {
      embedCalls = 0;
      const upgraded = openStore(dbPath);
      // Opening migrated it; syncing the same items again rewrites nothing and embeds nothing.
      await sync(upgraded, connector(legacyParents));
      await upgraded.embedChunks({ provider });
      upgraded.close();
      expect(invalidate).not.toHaveBeenCalled();
      expect(embedCalls).toBe(0);
    } finally {
      invalidate.mockRestore();
    }
    expect(snapshot(dbPath)).toEqual(before);

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query("SELECT version FROM schema_version WHERE store_id = 'connector-store'").get()).toEqual({ version: 15 });
      expect(db.query(`
        SELECT COUNT(*) AS rows,
          SUM(parent_local_item_id IS NULL) AS no_parent, SUM(deferred_locator IS NULL) AS no_locator,
          SUM(bytes_available IS NULL) AS no_availability, SUM(size_bytes IS NULL) AS no_size
        FROM items
      `).get()).toEqual({ rows: PARENTS.length, no_parent: PARENTS.length, no_locator: PARENTS.length, no_availability: PARENTS.length, no_size: PARENTS.length });
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_connector_store_items_parent'").all()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('opening an older store read-only works and shows no children', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'store.sqlite');
    const legacy = openStore(dbPath);
    await sync(legacy, connector(PARENTS.map((parent) => ({ ...parent, children: [] }))));
    legacy.close();
    rewindToV14(dbPath);

    const readOnly = new LocalConnectorStore({ dbPath, corpusId: 'secure_local.archive.email', family: 'email', trustDomain: 'secure_local', readOnly: true, tierLedger: null });
    try {
      expect(readOnly.childItemsOf(fixtureLocalItemId(ACCOUNT, 'msg-1'))).toEqual([]);
      expect(readOnly.deferredBytesOf(identityOf('msg-1#child:p1'))).toBeUndefined();
      expect(readOnly.extractionCandidates({ limit: 10 }).candidates.length).toBeGreaterThan(0);
    } finally {
      readOnly.close();
    }
  });
});

describe('child items: what the columns hold and the candidate query offers', () => {
  test('a child is stored by name with its parent, locator, availability and stated size, and no chunks', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'store.sqlite');
    const store = openStore(dbPath);
    await sync(store);
    store.close();

    const lease = childColumns(dbPath, fixtureLocalItemId(ACCOUNT, childProviderItemId('msg-1', 'p1')))!;
    expect(lease).toMatchObject({
      parent_local_item_id: fixtureLocalItemId(ACCOUNT, 'msg-1'),
      deferred_locator: fixtureLocator(ACCOUNT, PARENTS[0]!, PARENTS[0]!.children[0]!),
      bytes_available: 1,
      size_bytes: new TextEncoder().encode(PARENTS[0]!.children[0]!.text!).byteLength,
      tombstoned: 0,
    });
    expect(childColumns(dbPath, fixtureLocalItemId(ACCOUNT, childProviderItemId('msg-1', 'p2')))).toMatchObject({ bytes_available: 0 });
    expect(childColumns(dbPath, fixtureLocalItemId(ACCOUNT, 'msg-1'))).toMatchObject({
      parent_local_item_id: null, deferred_locator: null, bytes_available: null, size_bytes: null,
    });

    const db = new Database(dbPath, { readonly: true });
    try {
      // The parent's text is stored; a child's bytes are not read while syncing.
      const chunked = db.query(`
        SELECT i.provider_item_id AS id FROM items i
        WHERE EXISTS (SELECT 1 FROM chunks c WHERE c.item_pk = i.item_pk) ORDER BY id
      `).all();
      expect(chunked).toEqual([{ id: 'msg-1' }, { id: 'msg-2' }]);
    } finally {
      db.close();
    }
  });

  test('candidates carry the locator and size, and a child with no bytes is never offered', async () => {
    const dir = tempDir();
    const store = openStore(join(dir, 'store.sqlite'));
    await sync(store);
    const page = store.extractionCandidates({ limit: 50, withoutChunksOnly: true });
    store.close();

    expect(page.candidates.map((candidate) => candidate.identity.providerItemId)).toEqual(['msg-1#child:p1']);
    expect(page.candidates[0]).toMatchObject({
      parentLocalItemId: fixtureLocalItemId(ACCOUNT, 'msg-1'),
      deferredLocator: fixtureLocator(ACCOUNT, PARENTS[0]!, PARENTS[0]!.children[0]!),
      bytesAvailable: true,
      sizeBytes: new TextEncoder().encode(PARENTS[0]!.children[0]!.text!).byteLength,
      mimeType: 'application/pdf',
      name: 'lease.pdf',
    });
  });

  test('the locator is read back fresh, only for the version it was written for', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'store.sqlite');
    const store = openStore(dbPath);
    await sync(store);
    const id = identityOf('msg-1#child:p1');
    const locator = fixtureLocator(ACCOUNT, PARENTS[0]!, PARENTS[0]!.children[0]!);

    expect(store.deferredBytesOf(id)).toMatchObject({ locator });
    expect(store.deferredBytesOf(id, 'v1')).toMatchObject({ locator });
    expect(store.deferredBytesOf(id, 'v2')).toBeUndefined();
    expect(store.deferredBytesOf(identityOf('msg-1#child:p2'))).toBeUndefined();
    expect(store.deferredBytesOf(identityOf('msg-2'))).toBeUndefined();

    // The source replaces the parent: the new listing carries a new locator and the old one is gone.
    const replaced = PARENTS.map((parent) => parent.id === 'msg-1' ? { ...parent, version: 'v2' } : parent);
    await sync(store, connector(replaced));
    expect(store.deferredBytesOf(id, 'v1')).toBeUndefined();
    expect(store.deferredBytesOf(id, 'v2')).toMatchObject({
      locator: fixtureLocator(ACCOUNT, replaced[0]!, replaced[0]!.children[0]!),
    });
    store.close();
  });

  test('a new version listed without bytes to defer drops the old locator; a fetch of the same version keeps it', async () => {
    const dir = tempDir();
    const store = openStore(join(dir, 'store.sqlite'));
    const child = (version: string, deferred: boolean): RawItem => ({
      identity: {
        family: 'email', provider: PROVIDER, accountScope: ACCOUNT, providerItemId: 'm#child:a',
        localItemId: `${ACCOUNT}:m#child:a`, sourceVersion: version,
        parent: { providerItemId: 'm', localItemId: `${ACCOUNT}:m` },
      },
      mimeType: 'application/pdf',
      content: { kind: 'metadata_only' },
      metadata: Object.freeze({ name: 'a.pdf' }),
      fetchedAt: '2026-10-25T00:00:00.000Z',
      ...(deferred ? { deferredBytes: { locator: `loc-${version}`, available: true, sizeBytes: 10 } } : {}),
    });
    const only = (item: RawItem): SourceConnector => ({
      id: 'inline', family: 'email', async authenticate() {},
      listItems(): AsyncIterable<SourceConnectorListPage> { return (async function* () { yield { items: [item], done: true }; })(); },
      async fetchItem() { return item; },
      classificationSignals() { return {}; },
    });
    await sync(store, only(child('v1', true)));
    expect(store.deferredBytesOf(identityOf('m#child:a'))).toEqual({ locator: 'loc-v1', sizeBytes: 10 });
    // The same version listed again with no deferral (a fetch's answer): untouched.
    await sync(store, only(child('v1', false)));
    expect(store.deferredBytesOf(identityOf('m#child:a'))).toEqual({ locator: 'loc-v1', sizeBytes: 10 });
    // A new version with none: the old locator was bound to the old version.
    await sync(store, only(child('v2', false)));
    expect(store.deferredBytesOf(identityOf('m#child:a'))).toBeUndefined();
    store.close();
  });

  test('children are found by their parent link, hidden ones too, and a tombstoned child has no locator', async () => {
    const dir = tempDir();
    const store = openStore(join(dir, 'store.sqlite'));
    await sync(store);
    const parentLocal = fixtureLocalItemId(ACCOUNT, 'msg-1');
    expect(store.childItemsOf(parentLocal).map((child) => child.providerItemId)).toEqual(['msg-1#child:p1', 'msg-1#child:p2']);
    expect(store.parentLocalItemIdOf(identityOf('msg-1#child:p1'))).toBe(parentLocal);
    expect(store.parentLocalItemIdOf(identityOf('msg-1'))).toBeUndefined();
    expect(store.childItemsOf(fixtureLocalItemId(ACCOUNT, 'msg-2'))).toEqual([]);

    store.tombstoneCopy({
      family: 'email', provider: PROVIDER, accountScope: ACCOUNT, providerItemId: 'msg-1#child:p1',
      localItemId: fixtureLocalItemId(ACCOUNT, 'msg-1#child:p1'),
    }, { connectorId: 'test' });
    expect(store.deferredBytesOf(identityOf('msg-1#child:p1'))).toBeUndefined();
    expect(store.childItemsOf(parentLocal).map((child) => child.providerItemId)).toEqual(['msg-1#child:p1', 'msg-1#child:p2']);
    store.close();
  });

  test('a tier move carries the four columns with the row', async () => {
    const dir = tempDir();
    const source = openStore(join(dir, 'secure.sqlite'));
    const target = openStore(join(dir, 'internal.sqlite'), 'internal.archive.email', 'internal');
    await sync(source);
    const copy = source.exportItemCopy(identityOf('msg-1#child:p1'));
    expect(copy).toBeDefined();
    target.importItemCopy(copy!, { trustTier: 'S3', syncConnectorId: 'test-move', layers: 'metadata' });
    expect(target.deferredBytesOf(identityOf('msg-1#child:p1'))).toMatchObject({
      locator: fixtureLocator(ACCOUNT, PARENTS[0]!, PARENTS[0]!.children[0]!),
    });
    expect(target.parentLocalItemIdOf(identityOf('msg-1#child:p1'))).toBe(fixtureLocalItemId(ACCOUNT, 'msg-1'));
    source.close();
    target.close();
  });
});
